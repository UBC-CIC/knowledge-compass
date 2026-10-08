#!/usr/bin/env node
/**
 * Manual migration harness (NOT a *.test.js file, so `npm run test:lambda` skips it).
 *
 *   node cdk/lambda/db_setup/tests/docker_migration_check.js
 *
 * Starts a throwaway pgvector/pgvector:pg16 container (no published port; every
 * statement goes through `docker exec ... psql`), applies migrations 000..031 in
 * order through a `pgm` shim that collects `pgm.sql` text, seeds a corpus, creates
 * the `readwrite` role and a login role that mimics `app_rw`, then applies 032 and
 * checks its behavior (backfill, SECURITY DEFINER index functions, per-space
 * partial HNSW indexes, compatibility trigger, cascade, planner use of the index,
 * and an idempotent down/up round trip). The container is always removed, even on
 * failure or Ctrl-C. Exit code 0 only when every check passed.
 *
 * Requires Docker and the pgvector/pgvector:pg16 image (pulled if missing).
 * Uses only synthetic random data; nothing real is read or written.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const IMAGE = "pgvector/pgvector:pg16";
const CONTAINER = `kc-mig-check-${process.pid}`;
const DB = "kc";
const SUPERUSER = "postgres";
const SUPERPASS = "harness-pw";
const APP_USER = "kc_app_rw";
const APP_PASS = "harness-app-pw";
const OTHER_USER = "kc_stranger";
const OTHER_PASS = "harness-other-pw";
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const DUMP_SCRIPT = path.join(__dirname, "dump_writer_sql.py");
const SEED_ROWS = 2000;

let started = false;
const results = [];

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
}

/** Run SQL through psql inside the container. Returns { ok, out, err }. */
function psql(sql, { user = SUPERUSER, password = SUPERPASS, single = false, db = DB } = {}) {
  const args = ["exec", "-i", "-e", `PGPASSWORD=${password}`, CONTAINER, "psql", "-h", "127.0.0.1",
    "-U", user, "-d", db, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
  if (single) args.push("-1");
  args.push("-f", "-");
  const result = docker(args, { input: sql });
  return { ok: result.status === 0, out: (result.stdout || "").trim(), err: (result.stderr || "").trim() };
}

function mustPsql(sql, options) {
  const result = psql(sql, options);
  if (!result.ok) throw new Error(`psql failed: ${result.err.split("\n").slice(0, 4).join(" | ")}`);
  return result.out;
}

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(error.message).split("\n").join("\n      ")}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanup() {
  if (!started) return;
  started = false;
  const removed = docker(["rm", "-f", CONTAINER]);
  console.log(removed.status === 0 ? `Removed container ${CONTAINER}` : `Could not remove container ${CONTAINER}: ${removed.stderr}`);
}

function startContainer() {
  const image = docker(["image", "inspect", IMAGE]);
  if (image.status !== 0) {
    console.log(`Pulling ${IMAGE} ...`);
    const pulled = docker(["pull", IMAGE]);
    if (pulled.status !== 0) throw new Error(`docker pull failed: ${pulled.stderr}`);
  }
  const run = docker(["run", "-d", "--name", CONTAINER, "-e", `POSTGRES_PASSWORD=${SUPERPASS}`,
    "-e", `POSTGRES_DB=${DB}`, "-e", `POSTGRES_USER=${SUPERUSER}`, IMAGE]);
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  started = true;
  // The image restarts the server after init; pg_isready over TCP is true only for the final server.
  for (let i = 0; i < 60; i += 1) {
    const ready = docker(["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", SUPERUSER, "-d", DB]);
    if (ready.status === 0) {
      const probe = psql("SELECT 1");
      if (probe.ok) return;
    }
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
  }
  throw new Error("Postgres did not become ready in 60 s");
}

/** Load a migration file and collect its SQL via a `pgm` shim. */
function collect(file, direction) {
  const migration = require(path.join(MIGRATIONS_DIR, file));
  const statements = [];
  let transactional = true;
  const pgm = {
    sql: (text, args) => {
      let sql = String(text);
      for (const [key, value] of Object.entries(args || {})) sql = sql.split(`{${key}}`).join(String(value));
      statements.push(sql);
    },
    noTransaction: () => { transactional = false; },
  };
  migration[direction](pgm);
  return { sql: statements.join("\n"), transactional };
}

function applyMigration(file, direction = "up") {
  const { sql, transactional } = collect(file, direction);
  mustPsql(sql, { single: transactional });
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.js$/.test(f)).sort();
}

function randomArray(dims) {
  return Array.from({ length: dims }, () => Number((Math.random() * 2 - 1).toFixed(5)));
}

function randomVector(dims) {
  return "[" + randomArray(dims).join(",") + "]";
}

/** Run dump_writer_sql.py (real writer/retrieval code, recording cursor) and return its statements. */
function dumpList(request) {
  for (const command of [["py", ["-3"]], ["python3", []], ["python", []]]) {
    const result = spawnSync(command[0], [...command[1], DUMP_SCRIPT], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error) continue;
    if (result.status !== 0) throw new Error(`dump_writer_sql.py failed: ${(result.stderr || "").split("\n").slice(-4).join(" | ")}`);
    return JSON.parse(result.stdout);
  }
  return null;
}

function dumpSql(request) {
  const list = dumpList(request);
  return list && Object.fromEntries(list.map((s) => [s.name, s]));
}

const sqlLiteral = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return `ARRAY[${v.map(sqlLiteral).join(",")}]::text[]`;
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

/** Substitute psycopg2-style %s placeholders with SQL literals (as psycopg2 does client-side). */
const fillParams = (statement) => {
  let i = 0;
  return statement.sql.replace(/%s/g, () => sqlLiteral(statement.params[i++]));
};

const skip = (name, reason) => {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}  (${reason})`);
};

function seed() {
  mustPsql(`
    INSERT INTO sources (name, url, source_type)
    SELECT 's' || n, 'https://example.org/' || n, 'web'::source_type FROM generate_series(1, ${SEED_ROWS}) n;

    -- The subquery references n so each row gets its own random vector.
    INSERT INTO chunks (source_id, chunk_index, body, embed_text, word_count, content_hash, embedding)
    SELECT s.id, 0, 'body ' || n, 'embed text ' || n, 3, md5(n::text),
           (SELECT array_agg(random()::real) FROM generate_series(1, 1024 + (n * 0)))::vector(1024)
      FROM generate_series(1, ${SEED_ROWS}) n JOIN sources s ON s.name = 's' || n;

    -- A few chunks without embeddings: they must not be backfilled.
    INSERT INTO chunks (source_id, chunk_index, body, embed_text, word_count, content_hash)
    SELECT id, 1, 'no vector', 'no vector text ' || name, 3, md5(name) FROM sources WHERE name IN ('s1','s2','s3','s4','s5');
  `);
}

function createRoles() {
  // Mirrors db_setup/index.js createAppUsers: group role first, then login roles.
  mustPsql(`
    CREATE ROLE readwrite;
    GRANT CONNECT ON DATABASE ${DB} TO readwrite;
    GRANT USAGE ON SCHEMA public TO readwrite;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO readwrite;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO readwrite;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO readwrite;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO readwrite;
    CREATE USER ${APP_USER} WITH PASSWORD '${APP_PASS}';
    GRANT readwrite TO ${APP_USER};
    CREATE USER ${OTHER_USER} WITH PASSWORD '${OTHER_PASS}';
    GRANT CONNECT ON DATABASE ${DB} TO ${OTHER_USER};
    GRANT USAGE ON SCHEMA public TO ${OTHER_USER};
  `);
}

const asApp = (sql) => psql(sql, { user: APP_USER, password: APP_PASS });
const legacyId = () => mustPsql("SELECT id FROM embedding_spaces WHERE name = 'cohere-v3-1024'");
const count = (sql) => Number(mustPsql(sql));

function runChecks() {
  const t0 = Date.now();
  applyMigration("032_embedding_spaces.js", "up");
  const upSeconds = ((Date.now() - t0) / 1000).toFixed(1);
  check("032 up applies on a database that already has embedded chunks", () => `${upSeconds} s incl. backfill and legacy HNSW build over ${SEED_ROWS} rows`);

  const legacy = legacyId();

  check("backfill row count equals non-null chunks.embedding rows", () => {
    const expected = count("SELECT count(*) FROM chunks WHERE embedding IS NOT NULL");
    const actual = count(`SELECT count(*) FROM chunk_embeddings WHERE space_id = '${legacy}'`);
    assert(expected === SEED_ROWS && actual === expected, `chunks=${expected}, chunk_embeddings=${actual}`);
    return `${actual} rows`;
  });

  check("NULL-embedding chunks were not backfilled", () => {
    const rows = count("SELECT count(*) FROM chunk_embeddings ce JOIN chunks c ON c.id = ce.chunk_id WHERE c.embedding IS NULL");
    assert(rows === 0, `${rows} rows`);
  });

  check("embed_hash = md5(embed_text) for every backfilled row", () => {
    const bad = count("SELECT count(*) FROM chunk_embeddings ce JOIN chunks c ON c.id = ce.chunk_id WHERE ce.embed_hash <> md5(c.embed_text)");
    assert(bad === 0, `${bad} mismatches`);
  });

  check("legacy space is registered, active and pointed to; price and EOL are NULL", () => {
    const row = mustPsql(`SELECT s.status, s.min_score, s.split_threshold, s.price_per_1m_tokens IS NULL, s.eol_date IS NULL, a.space_id = s.id
                            FROM embedding_spaces s, embedding_active_space a WHERE s.name = 'cohere-v3-1024'`);
    assert(row === "active|0.400|0.600|t|t|t", row);
  });

  check("legacy partial HNSW index exists and old idx_chunks_embedding_hnsw is untouched", () => {
    const names = mustPsql("SELECT indexname FROM pg_indexes WHERE tablename IN ('chunks','chunk_embeddings') AND (indexname LIKE 'idx_ce_hnsw_%' OR indexname = 'idx_chunks_embedding_hnsw') ORDER BY 1").split("\n");
    const expected = `idx_ce_hnsw_${legacy.replace(/-/g, "")}`;
    assert(names.includes(expected) && names.includes("idx_chunks_embedding_hnsw"), names.join(","));
    return expected;
  });

  mustPsql(`GRANT SELECT ON chunks TO ${OTHER_USER}; GRANT SELECT ON embedding_spaces TO ${OTHER_USER};`);

  check("non-owner readwrite member can call create_space_index; a direct CREATE INDEX is denied", () => {
    const viaFunction = asApp(`SELECT create_space_index('${legacy}')`);
    assert(viaFunction.ok, `function call failed: ${viaFunction.err}`);
    const direct = asApp("CREATE INDEX kc_direct_probe ON chunk_embeddings USING hnsw ((embedding::vector(1024)) vector_cosine_ops) WHERE space_id = gen_random_uuid()");
    assert(!direct.ok && /must be owner/.test(direct.err), `direct CREATE INDEX was not denied: ${direct.err}`);
    return "direct: " + direct.err.split("\n")[0];
  });

  check("a role outside readwrite cannot execute the index functions (PUBLIC revoked)", () => {
    const denied = psql(`SELECT create_space_index('${legacy}')`, { user: OTHER_USER, password: OTHER_PASS });
    assert(!denied.ok && /permission denied/.test(denied.err), denied.err || "call succeeded");
  });

  check("create_space_index twice is a no-op (same index OID)", () => {
    const before = mustPsql(`SELECT oid FROM pg_class WHERE relname = 'idx_ce_hnsw_${legacy.replace(/-/g, "")}'`);
    const again = asApp(`SELECT create_space_index('${legacy}')`);
    assert(again.ok, again.err);
    const after = mustPsql(`SELECT oid FROM pg_class WHERE relname = 'idx_ce_hnsw_${legacy.replace(/-/g, "")}'`);
    assert(before && before === after, `${before} -> ${after}`);
  });

  let space512 = null;
  check("a 512-dim space gets its own index through the app role; 512-dim vectors insert", () => {
    space512 = mustPsql(`INSERT INTO embedding_spaces (name, provider, model_id, invoke_target, dimensions, status)
                          VALUES ('titan-v2-512', 'titan_v2', 'amazon.titan-embed-text-v2:0', 'amazon.titan-embed-text-v2:0', 512, 'building')
                          RETURNING id`).split("\n")[0];
    const created = asApp(`SELECT create_space_index('${space512}')`);
    assert(created.ok, created.err);
    const vec512 = randomVector(512);
    const insert = asApp(`INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash)
                           SELECT id, '${space512}', '${vec512}'::vector, md5(embed_text) FROM chunks WHERE embedding IS NOT NULL LIMIT 3`);
    assert(insert.ok, insert.err);
    return created.out;
  });

  check("a 1024-dim insert into the 512 space fails at index time (documented)", () => {
    const wrong = asApp(`INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash)
                          SELECT id, '${space512}', '${randomVector(1024)}'::vector, md5(embed_text) FROM chunks WHERE embedding IS NOT NULL OFFSET 10 LIMIT 1`);
    assert(!wrong.ok, "insert unexpectedly succeeded");
    return wrong.err.split("\n")[0];
  });

  check("a 512-dim insert does not disturb the legacy space or its index", () => {
    assert(count(`SELECT count(*) FROM chunk_embeddings WHERE space_id = '${legacy}'`) === SEED_ROWS, "legacy rows changed");
  });

  check("compat trigger mirrors UPDATE chunks.embedding into the legacy space only", () => {
    const target = mustPsql("SELECT id FROM chunks WHERE embedding IS NOT NULL ORDER BY id LIMIT 1");
    const before512 = mustPsql(`SELECT md5(embedding::text) FROM chunk_embeddings WHERE chunk_id = '${target}' AND space_id = '${space512}'`);
    const vec = randomVector(1024);
    mustPsql(`UPDATE chunks SET embedding = '${vec}'::vector(1024) WHERE id = '${target}'`);
    const mirrored = mustPsql(`SELECT (embedding = '${vec}'::vector) FROM chunk_embeddings WHERE chunk_id = '${target}' AND space_id = '${legacy}'`);
    const after512 = mustPsql(`SELECT md5(embedding::text) FROM chunk_embeddings WHERE chunk_id = '${target}' AND space_id = '${space512}'`);
    assert(mirrored === "t", "legacy row not updated");
    assert(before512 === after512, "other space changed");
  });

  check("compat trigger mirrors INSERT of a new chunk with an embedding; embed_hash is md5(embed_text)", () => {
    const sourceId = mustPsql("SELECT id FROM sources WHERE name = 's6'");
    const id = mustPsql(`INSERT INTO chunks (source_id, chunk_index, body, embed_text, word_count, content_hash, embedding)
                          VALUES ('${sourceId}', 7, 'b', 'trigger insert text', 3, 'h', '${randomVector(1024)}'::vector(1024)) RETURNING id`).split("\n")[0];
    const ok = mustPsql(`SELECT embed_hash = md5('trigger insert text') FROM chunk_embeddings WHERE chunk_id = '${id}' AND space_id = '${legacy}'`);
    assert(ok === "t", "no mirrored row or wrong hash");
  });

  check("a chunk written without an embedding (new writer path) creates no mirror row", () => {
    const sourceId = mustPsql("SELECT id FROM sources WHERE name = 's7'");
    const id = mustPsql(`INSERT INTO chunks (source_id, chunk_index, body, embed_text, word_count, content_hash)
                          VALUES ('${sourceId}', 8, 'b', 'no vector here', 3, 'h') RETURNING id`).split("\n")[0];
    assert(count(`SELECT count(*) FROM chunk_embeddings WHERE chunk_id = '${id}'`) === 0, "unexpected row");
  });

  check("deleting a chunk cascades to every space", () => {
    const target = mustPsql(`SELECT chunk_id FROM chunk_embeddings WHERE space_id = '${space512}' LIMIT 1`);
    assert(count(`SELECT count(*) FROM chunk_embeddings WHERE chunk_id = '${target}'`) === 2, "expected one row per space");
    mustPsql(`DELETE FROM chunks WHERE id = '${target}'`);
    assert(count(`SELECT count(*) FROM chunk_embeddings WHERE chunk_id = '${target}'`) === 0, "rows survived the delete");
  });

  const plan = (preamble) => mustPsql(`${preamble}
    EXPLAIN SELECT ce.chunk_id FROM chunk_embeddings ce
     WHERE ce.space_id = '${legacy}'
     ORDER BY ce.embedding::vector(1024) <=> '${randomVector(1024)}'::vector LIMIT 10;`);

  check("EXPLAIN of the retrieval shape uses the partial HNSW index", () => {
    mustPsql("ANALYZE chunk_embeddings");
    const natural = plan("");
    if (/Index Scan using idx_ce_hnsw_/.test(natural)) return "planner chose it with default settings";
    const forced = plan("SET enable_seqscan = off;");
    assert(/Index Scan using idx_ce_hnsw_/.test(forced), `no index scan even with enable_seqscan=off:\n${forced}`);
    return "needed SET enable_seqscan=off on this tiny table; default plan was: " + natural.split("\n")[0].trim();
  });

  // ── The real writer and retrieval SQL, executed against Postgres ───────────
  const probe = dumpSql({ mode: "tg", space_id: space512, dims: 512, vector: randomArray(512) });
  if (!probe) {
    skip("writer/retrieval SQL against Postgres", "no Python interpreter found: the writer, retrieval and container SQL was NOT run against a database");
  } else {
    const s10 = mustPsql("SELECT id FROM sources WHERE name = 's10'");
    const s11 = mustPsql("SELECT id FROM sources WHERE name = 's11'");
    const vec512 = randomArray(512);
    const plantedText = "planted writer text alpha";
    const request = (mode, over = {}) => ({ mode, source_id: s10, space_id: space512, dims: 512, text: plantedText, index: 5, vector: vec512, ...over });
    const chunkIdAt = (source, index) => mustPsql(`SELECT id FROM chunks WHERE source_id = '${source}' AND chunk_index = ${index}`);

    check("KB _upsert_chunk writes the chunk without chunks.embedding and the vector with md5(embed_text) (real SQL)", () => {
      const kb = dumpSql(request("kb"));
      mustPsql(fillParams(kb.kb_upsert));
      const id = chunkIdAt(s10, 5);
      const row = mustPsql(`SELECT c.embedding IS NULL, ce.embed_hash = md5(c.embed_text), ce.space_id = '${space512}'
                              FROM chunks c JOIN chunk_embeddings ce ON ce.chunk_id = c.id WHERE c.id = '${id}'`);
      assert(row === "t|t|t", `unexpected row: ${row}`);
      assert(count(`SELECT count(*) FROM chunk_embeddings WHERE chunk_id = '${id}' AND space_id = '${legacy}'`) === 0,
        "the legacy compatibility trigger fired although chunks.embedding was not written");
    });

    check("KB _upsert_chunk is idempotent and refreshes embed_hash when the text changes (real SQL)", () => {
      const before = count(`SELECT count(*) FROM chunks WHERE source_id = '${s10}'`);
      const kb = dumpSql(request("kb", { text: plantedText + " edited" }));
      mustPsql(fillParams(kb.kb_upsert));
      assert(count(`SELECT count(*) FROM chunks WHERE source_id = '${s10}'`) === before, "a duplicate chunk row was created");
      const id = chunkIdAt(s10, 5);
      assert(mustPsql(`SELECT ce.embed_hash = md5(c.embed_text) FROM chunks c JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.space_id = '${space512}' WHERE c.id = '${id}'`) === "t", "embed_hash is stale");
      assert(count(`SELECT count(*) FROM chunk_embeddings WHERE chunk_id = '${id}'`) === 1, "expected one vector row");
    });

    check("KB read queries are space-scoped: a legacy-only vector never counts for the new space (real SQL)", () => {
      // A chunk whose only vector is in the LEGACY space (written through the legacy column + trigger).
      const s12 = mustPsql("SELECT id FROM sources WHERE name = 's12'");
      const legacyText = "legacy only text gamma";
      mustPsql(`INSERT INTO chunks (source_id, chunk_index, body, embed_text, word_count, content_hash, embedding)
                 VALUES ('${s12}', 9, 'b', '${legacyText}', 3, 'ch-9', '${randomVector(1024)}'::vector(1024))`);
      const legacyChunk = chunkIdAt(s12, 9);
      assert(count(`SELECT count(*) FROM chunk_embeddings WHERE chunk_id = '${legacyChunk}' AND space_id = '${legacy}'`) === 1, "seed: legacy vector missing");

      const inNew = dumpSql(request("kb", { source_id: s12, text: legacyText, index: 9 }));
      assert(mustPsql(fillParams(inNew.kb_existing)) === "", "the new space reports a chunk that only the legacy space has a vector for");
      assert(mustPsql(fillParams(inNew.kb_reusable)) === "", "source-local reuse returned a legacy-space vector for the new space");
      assert(mustPsql(fillParams(inNew.kb_global)) === "", "global reuse returned a legacy-space vector for the new space");

      const inLegacy = dumpSql(request("kb", { source_id: s12, space_id: legacy, dims: 1024, vector: randomArray(1024), text: legacyText, index: 9 }));
      assert(mustPsql(fillParams(inLegacy.kb_existing)).split("\n").some((line) => line.startsWith("9|ch-9|")), "legacy space should know the chunk");
      assert(mustPsql(fillParams(inLegacy.kb_reusable)).startsWith("ch-9|"), "legacy source-local reuse should find its own vector");
      assert(mustPsql(fillParams(inLegacy.kb_global)).startsWith("ch-9|"), "legacy global reuse should find its own vector");
    });

    check("KB reuse queries return the new space's own current vector (real SQL)", () => {
      const kb = dumpSql(request("kb", { text: plantedText + " edited" }));
      const reusable = mustPsql(fillParams(kb.kb_reusable));
      const global = mustPsql(fillParams(kb.kb_global));
      assert(reusable.startsWith("ch-5|") && global.startsWith("ch-5|"), `reuse rows: ${reusable} / ${global}`);
    });

    check("retrieval SQL (retrieval_core) returns the planted chunk first and skips stale vectors (real SQL)", () => {
      const tg = dumpSql({ mode: "tg", space_id: space512, dims: 512, vector: vec512 });
      const top = mustPsql(fillParams(tg.tg_standard)).split("\n")[0];
      assert(top.startsWith(plantedText + " edited|"), `top row was: ${top.slice(0, 60)}`);
      const id = chunkIdAt(s10, 5);
      mustPsql(`UPDATE chunks SET embed_text = embed_text || ' drift' WHERE id = '${id}'`);   // text changed, vector not
      const after = mustPsql(fillParams(tg.tg_standard));
      assert(!after.includes(plantedText), "a vector made from older text was still returned");
      const kb = dumpSql(request("kb", { text: plantedText + " edited" }));
      assert(!mustPsql(fillParams(kb.kb_existing)).includes("5|"), "a chunk with a stale vector still counts as up to date");
    });

    check("retrieval SQL runs for the legacy space and returns rows; guideline candidate SQL executes (real SQL)", () => {
      const tg = dumpSql({ mode: "tg", space_id: legacy, dims: 1024, vector: randomArray(1024) });
      const rows = mustPsql(fillParams(tg.tg_standard)).split("\n").filter(Boolean);
      assert(rows.length > 0, "no rows from the legacy space");
      mustPsql(fillParams(tg.tg_guideline));
      return `${rows.length} rows`;
    });

    check("crawler and transcriber SQL write vectors to the space only and detect stale vectors (real SQL)", () => {
      const containers = dumpSql(request("containers", { source_id: s11, text: "container text beta", index: 6 }));
      mustPsql(fillParams(containers.crawler_upsert));
      const id = chunkIdAt(s11, 6);
      assert(mustPsql(`SELECT c.embedding IS NULL AND ce.embed_hash = md5(c.embed_text) FROM chunks c JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.space_id = '${space512}' WHERE c.id = '${id}'`) === "t", "crawler upsert");
      assert(mustPsql(fillParams(containers.crawler_existing)).includes("6|ch-6|t"), "crawler existing: current vector not detected");
      mustPsql(`UPDATE chunks SET embed_text = embed_text || ' drift' WHERE id = '${id}'`);
      assert(mustPsql(fillParams(containers.crawler_existing)).includes("6|ch-6|f"), "crawler existing: stale vector not detected");
      mustPsql(fillParams(containers.transcriber_upsert));   // same chunk slot, via the transcriber's SQL
      assert(mustPsql(fillParams(containers.transcriber_existing)).includes("6|ch-6|t"), "transcriber existing");
      assert(count(`SELECT count(*) FROM chunk_embeddings WHERE chunk_id = '${id}' AND space_id = '${legacy}'`) === 0, "legacy space was written by a container");
    });
  }

  check("drop_space_index refuses the active space; create_space_index refuses missing and purged spaces", () => {
    const dropActive = asApp(`SELECT drop_space_index('${legacy}')`);
    assert(!dropActive.ok && /is active/.test(dropActive.err), dropActive.err);
    const missing = asApp("SELECT create_space_index('00000000-0000-0000-0000-000000000000')");
    assert(!missing.ok && /does not exist/.test(missing.err), missing.err);
    mustPsql(`UPDATE embedding_spaces SET status = 'purged' WHERE id = '${space512}'`);
    const purged = asApp(`SELECT create_space_index('${space512}')`);
    assert(!purged.ok && /is purged/.test(purged.err), purged.err);
    mustPsql(`UPDATE embedding_spaces SET status = 'retired' WHERE id = '${space512}'`);
    const dropped = asApp(`SELECT drop_space_index('${space512}')`);
    assert(dropped.ok, dropped.err);
    assert(count(`SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_ce_hnsw_${space512.replace(/-/g, "")}'`) === 0, "index still present");
  });

  check("index.js grant block restores EXECUTE for readwrite (brand-new database case)", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const block = source.match(/DO \$\$\s*BEGIN\s*IF to_regprocedure\('create_space_index\(uuid\)'\)[\s\S]*?END\$\$;/);
    assert(block, "grant block not found in index.js");
    mustPsql("REVOKE EXECUTE ON FUNCTION create_space_index(uuid), drop_space_index(uuid) FROM readwrite");
    assert(mustPsql("SELECT has_function_privilege('readwrite', 'create_space_index(uuid)', 'EXECUTE')") === "f", "revoke did not apply");
    mustPsql(block[0]);
    assert(mustPsql("SELECT has_function_privilege('readwrite', 'create_space_index(uuid)', 'EXECUTE')") === "t", "grant block did not restore access");
  });

  check("032 down runs cleanly and leaves chunks.embedding and its old index alone", () => {
    applyMigration("032_embedding_spaces.js", "down");
    const left = count(`SELECT count(*) FROM information_schema.tables WHERE table_name IN ('embedding_spaces','embedding_active_space','chunk_embeddings')`)
      + count("SELECT count(*) FROM pg_proc WHERE proname IN ('create_space_index','drop_space_index','chunks_mirror_legacy_embedding')")
      + count("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_chunks_mirror_legacy_embedding'")
      + count("SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'idx_ce_hnsw_%'");
    assert(left === 0, `${left} objects left behind`);
    assert(count("SELECT count(*) FROM chunks WHERE embedding IS NOT NULL") > 0, "chunks.embedding data lost");
    assert(count("SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_chunks_embedding_hnsw'") === 1, "old index gone");
  });

  check("032 up re-applies cleanly after down (idempotent round trip) and backfills again", () => {
    applyMigration("032_embedding_spaces.js", "up");
    const again = legacyId();
    const expected = count("SELECT count(*) FROM chunks WHERE embedding IS NOT NULL");
    const actual = count(`SELECT count(*) FROM chunk_embeddings WHERE space_id = '${again}'`);
    assert(expected === actual, `chunks=${expected}, chunk_embeddings=${actual}`);
    applyMigration("032_embedding_spaces.js", "up"); // a second up is also a no-op
    assert(count(`SELECT count(*) FROM chunk_embeddings WHERE space_id = '${again}'`) === actual, "second up changed rows");
    return `${actual} rows`;
  });

  runJobChecks();
}

/** Migration 033 (embedding_jobs) and the re-embed work-list query. Runs on top of 032. */
function runJobChecks() {
  applyMigration("033_embedding_jobs.js", "up");
  const legacy = legacyId();

  const newSpace = (name) => mustPsql(`INSERT INTO embedding_spaces (name, provider, model_id, invoke_target, dimensions, status)
                                        VALUES ('${name}', 'cohere_v3', 'cohere.embed-english-v3', 'cohere.embed-english-v3', 1024, 'building')
                                        RETURNING id`).split("\n")[0];
  const spaceA = newSpace("jobs-space-a");
  const spaceB = newSpace("jobs-space-b");
  const addJob = (space, mode, status = "queued") => psql(`INSERT INTO embedding_jobs (space_id, mode, status) VALUES ('${space}', '${mode}', '${status}')`);

  check("033 up applies; embedding_jobs, both partial unique indexes and the history index exist", () => {
    const names = mustPsql("SELECT indexname FROM pg_indexes WHERE tablename = 'embedding_jobs' ORDER BY 1").split("\n");
    for (const expected of ["embedding_jobs_one_active_cutover", "embedding_jobs_one_active_rebuild", "embedding_jobs_space_created_idx"]) {
      assert(names.includes(expected), `missing ${expected} (have ${names.join(", ")})`);
    }
    // `cursor` is a non-reserved keyword; the column must work unquoted.
    mustPsql(`SELECT cursor, processed, price_configured, steps FROM embedding_jobs LIMIT 1`);
  });

  check("CHECK constraints reject an unknown mode and an unknown status", () => {
    const badMode = addJob(spaceA, "purge");
    assert(!badMode.ok && /violates check constraint/.test(badMode.err), badMode.err || "accepted");
    const badStatus = addJob(spaceA, "rebuild", "paused");
    assert(!badStatus.ok && /violates check constraint/.test(badStatus.err), badStatus.err || "accepted");
  });

  check("only one queued/running rebuild|delta job per space; other spaces, modes and finished jobs are unaffected", () => {
    assert(addJob(spaceA, "rebuild").ok, "first rebuild rejected");
    const dup = addJob(spaceA, "delta", "running");
    assert(!dup.ok && /embedding_jobs_one_active_rebuild/.test(dup.err), dup.err || "second active rebuild accepted");
    assert(addJob(spaceB, "rebuild").ok, "another space was blocked");
    assert(addJob(spaceA, "dry_run").ok, "dry_run should not be limited");
    assert(addJob(spaceA, "validate").ok, "validate should not be limited");
    mustPsql(`UPDATE embedding_jobs SET status = 'succeeded' WHERE space_id = '${spaceA}' AND mode = 'rebuild'`);
    assert(addJob(spaceA, "rebuild").ok, "a finished job still blocks");
  });

  check("only one queued/running activate|rollback job in total", () => {
    assert(addJob(spaceA, "activate").ok, "first cutover rejected");
    const dup = addJob(spaceB, "rollback", "running");
    assert(!dup.ok && /embedding_jobs_one_active_cutover/.test(dup.err), dup.err || "second cutover accepted");
    mustPsql("UPDATE embedding_jobs SET status = 'failed' WHERE mode IN ('activate', 'rollback')");
    assert(addJob(spaceB, "rollback").ok, "a failed cutover still blocks");
    mustPsql("UPDATE embedding_jobs SET status = 'cancelled' WHERE mode IN ('activate', 'rollback')");
  });

  check("the app role (readwrite member) can insert, update and read embedding_jobs", () => {
    const insert = asApp(`INSERT INTO embedding_jobs (space_id, mode) VALUES ('${spaceB}', 'dry_run') RETURNING id`);
    assert(insert.ok, insert.err);
    const id = insert.out.split("\n")[0];
    const update = asApp(`UPDATE embedding_jobs SET status = 'running', processed = processed + 5, cursor = '${legacy}', steps = '[{"name":"lock"}]'::jsonb WHERE id = '${id}'`);
    assert(update.ok, update.err);
    assert(asApp(`SELECT processed FROM embedding_jobs WHERE id = '${id}'`).out === "5", "update not visible");
  });

  // The work-list query from helpers/reembed_space.py, as the code runs it.
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "knowledgeBase", "helpers", "reembed_space.py"), "utf8");
  const match = source.match(/_SELECT_BATCH_SQL = """([\s\S]*?)"""/);
  const selectBatch = (space, cursorId, limit) =>
    mustPsql(fillParams({ sql: match[1], params: [space, cursorId, limit] })).split("\n").filter(Boolean).map((line) => line.split("|")[0]);
  const NIL = "00000000-0000-0000-0000-000000000000";

  check("re-embed work-list query returns exactly the missing and stale chunks, in id order, from the cursor", () => {
    assert(match, "_SELECT_BATCH_SQL not found in reembed_space.py");
    // 10 current vectors, 1 stale vector, the rest missing.
    mustPsql(`INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash)
              SELECT id, '${spaceA}', embedding, md5(embed_text) FROM chunks WHERE embedding IS NOT NULL ORDER BY id LIMIT 10`);
    mustPsql(`INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash)
              SELECT id, '${spaceA}', embedding, md5('something else') FROM chunks WHERE embedding IS NOT NULL ORDER BY id OFFSET 10 LIMIT 1`);
    const expectedAll = mustPsql(`SELECT c.id FROM chunks c LEFT JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.space_id = '${spaceA}'
                                  WHERE ce.chunk_id IS NULL OR ce.embed_hash <> md5(c.embed_text) ORDER BY c.id`).split("\n");
    const total = count("SELECT count(*) FROM chunks");
    assert(expectedAll.length === total - 10, `expected ${total - 10} remaining, saw ${expectedAll.length}`);

    const first = selectBatch(spaceA, NIL, 5);
    assert(JSON.stringify(first) === JSON.stringify(expectedAll.slice(0, 5)), "first batch differs from the expected ids");
    const stale = mustPsql(`SELECT c.id FROM chunks c JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.space_id = '${spaceA}' WHERE ce.embed_hash <> md5(c.embed_text)`);
    assert(expectedAll.includes(stale), "the stale chunk is not in the work list");

    const next = selectBatch(spaceA, first[4], 5);
    assert(JSON.stringify(next) === JSON.stringify(expectedAll.slice(5, 10)), "cursor was not honored");
    assert(selectBatch(spaceA, expectedAll[expectedAll.length - 1], 5).length === 0, "rows after the last id");
  });

  check("the work list is scoped to the space (legacy space is complete, so nothing is left for it)", () => {
    assert(selectBatch(legacy, NIL, 10).length === count(`SELECT count(*) FROM chunks c LEFT JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.space_id = '${legacy}' WHERE ce.chunk_id IS NULL`),
      "legacy-space work list differs from its missing chunks");
  });

  check("upserting a vector makes the chunk leave the work list; re-running the upsert is idempotent", () => {
    const [target] = selectBatch(spaceA, NIL, 1);
    const upsert = `INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash, embedded_at)
                    SELECT c.id, '${spaceA}'::uuid, '${randomVector(1024)}'::vector, md5(c.embed_text), now() FROM chunks c WHERE c.id = '${target}'::uuid
                    ON CONFLICT (chunk_id, space_id) DO UPDATE SET embedding = EXCLUDED.embedding, embed_hash = EXCLUDED.embed_hash, embedded_at = EXCLUDED.embedded_at`;
    mustPsql(upsert);
    mustPsql(upsert);
    assert(count(`SELECT count(*) FROM chunk_embeddings WHERE chunk_id = '${target}' AND space_id = '${spaceA}'`) === 1, "duplicate rows");
    assert(!selectBatch(spaceA, NIL, 1000000).includes(target), "chunk still in the work list");
    // Chunk deleted between read and write: the INSERT .. SELECT writes nothing instead of failing the FK.
    const gone = mustPsql(`INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash, embedded_at)
                           SELECT c.id, '${spaceA}'::uuid, '${randomVector(1024)}'::vector, 'x', now() FROM chunks c WHERE c.id = '${NIL}'::uuid RETURNING chunk_id`);
    assert(gone === "", "wrote a vector for a chunk that does not exist");
  });

  // Cutover, lock, validation and re-embed statements: the real SQL the code builds.
  const cutoverSpace = newSpace("cutover-new");
  mustPsql(`UPDATE embedding_spaces SET status = 'validated' WHERE id = '${cutoverSpace}'`);
  const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const dump = () => dumpList({ mode: "jobs", job_id: JOB, old_space_id: legacy, new_space_id: cutoverSpace, kind: "activate" });
  const jobsSql = dump();
  const stmt = (name, nth = 0) => {
    const found = (jobsSql || []).filter((s) => s.name === name)[nth];
    assert(found, `statement ${name}#${nth} not produced by the code`);
    return fillParams(found);
  };
  const lockRow = () => mustPsql("SELECT cutover_locked, coalesce(cutover_job_id::text, ''), cutover_locked_at IS NOT NULL FROM embedding_active_space");

  if (jobsSql === null) {
    skip("cutover / validation / re-embed SQL against Postgres", "no Python interpreter for dump_writer_sql.py");
  } else {
    check("lock: acquire is compare-and-swap; a live lock of another job is untouched; an expired one is taken over", () => {
      mustPsql(stmt("acquire_lock"));
      assert(lockRow() === `t|${JOB}|t`, `after acquire: ${lockRow()}`);
      mustPsql(stmt("acquire_lock").replace(new RegExp(JOB, "g"), OTHER));     // another job tries
      assert(lockRow() === `t|${JOB}|t`, `a live lock was taken over: ${lockRow()}`);
      mustPsql(stmt("acquire_lock"));                                           // re-entry by the owner
      assert(lockRow() === `t|${JOB}|t`, "owner re-entry changed the lock");
      mustPsql("UPDATE embedding_active_space SET cutover_locked_at = now() - interval '2 hours'");
      mustPsql(stmt("acquire_lock").replace(new RegExp(JOB, "g"), OTHER));     // TTL passed
      assert(lockRow() === `t|${OTHER}|t`, `expired lock not taken over: ${lockRow()}`);
      mustPsql(stmt("acquire_lock"));                                           // not locked by us, live: refused
      assert(lockRow() === `t|${OTHER}|t`, "took a live lock");
    });

    check("lock: heartbeat only refreshes the owner's lock; release only clears the owner's lock", () => {
      mustPsql(`UPDATE embedding_active_space SET cutover_locked_at = now() - interval '10 minutes', cutover_job_id = '${JOB}', cutover_locked = true`);
      mustPsql(stmt("heartbeat", 0));
      assert(count("SELECT count(*) FROM embedding_active_space WHERE cutover_locked_at > now() - interval '1 minute'") === 1, "heartbeat did not refresh");
      mustPsql(`UPDATE embedding_active_space SET cutover_job_id = '${OTHER}', cutover_locked_at = now() - interval '10 minutes'`);
      mustPsql(stmt("heartbeat", 0));
      assert(count("SELECT count(*) FROM embedding_active_space WHERE cutover_locked_at > now() - interval '1 minute'") === 0, "heartbeat refreshed someone else's lock");
      mustPsql(stmt("release_lock"));
      assert(lockRow() === `t|${OTHER}|t`, "released someone else's lock");
      mustPsql(`UPDATE embedding_active_space SET cutover_job_id = '${JOB}'`);
      mustPsql(stmt("release_lock"));
      assert(lockRow() === "f||f", `lock not released: ${lockRow()}`);
    });

    check("lock_state SQL (used by every ingestion entry point) reports locked, expired and unlocked", () => {
      const read = () => mustPsql(stmt("lock_state"));
      assert(read().startsWith("f|"), `unlocked: ${read()}`);
      mustPsql(`UPDATE embedding_active_space SET cutover_locked = true, cutover_locked_at = now(), cutover_job_id = '${JOB}'`);
      const live = read().split("|");
      assert(live[0] === "t" && live[3] === "f", `live lock: ${live}`);
      mustPsql("UPDATE embedding_active_space SET cutover_locked_at = now() - interval '31 minutes'");
      assert(read().split("|")[3] === "t", "a lock past 30 minutes was not reported expired");
      mustPsql("UPDATE embedding_active_space SET cutover_locked = false, cutover_locked_at = NULL, cutover_job_id = NULL");
    });

    check("ingestion-idle query runs against the ingestion_status enum", () => {
      assert(Number(mustPsql(stmt("running_ingestion"))) >= 0, "no count");
    });

    check("flip: one transaction retires the old space, activates the new one and moves the pointer; a second run changes nothing", () => {
      const flip = [stmt("flip", 0), stmt("flip", 1), stmt("flip", 2)].join(";\n");
      mustPsql(flip, { single: true });
      const state = () => mustPsql(`SELECT (SELECT status FROM embedding_spaces WHERE id = '${legacy}'), (SELECT status FROM embedding_spaces WHERE id = '${cutoverSpace}'),
                                           (SELECT space_id::text FROM embedding_active_space), (SELECT activated_at IS NOT NULL FROM embedding_spaces WHERE id = '${cutoverSpace}'),
                                           (SELECT retired_at IS NOT NULL FROM embedding_spaces WHERE id = '${legacy}')`);
      assert(state() === `retired|active|${cutoverSpace}|t|t`, `after flip: ${state()}`);
      mustPsql(flip, { single: true });
      assert(state() === `retired|active|${cutoverSpace}|t|t`, `a repeated flip changed state: ${state()}`);
      // Put things back for the remaining checks.
      mustPsql(`UPDATE embedding_spaces SET status = 'active' WHERE id = '${legacy}';
                UPDATE embedding_spaces SET status = 'validated' WHERE id = '${cutoverSpace}';
                UPDATE embedding_active_space SET space_id = '${legacy}'`);
    });

    check("validation coverage and per-source-type SQL run; counts agree with an independent query", () => {
      const missing = Number(mustPsql(stmt("coverage", 0)));
      const expected = count(`SELECT count(*) FROM chunks c LEFT JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.space_id = '${cutoverSpace}'
                              WHERE ce.chunk_id IS NULL OR ce.embed_hash <> md5(c.embed_text)`);
      assert(missing === expected, `coverage ${missing} vs ${expected}`);
      const sample = mustPsql(stmt("coverage", 1)).split("\n").filter(Boolean);
      assert(sample.length === Math.min(20, expected), `sample size ${sample.length}`);
      const types = mustPsql(stmt("source_types")).split("\n").filter(Boolean).map((l) => l.split("|"));
      const chunksInTypes = types.reduce((n, row) => n + Number(row[1]), 0);
      assert(chunksInTypes === count("SELECT count(*) FROM chunks"), "per-type chunk counts do not add up to all chunks");
      assert(types.every((row) => Number(row[2]) === 0), "empty target space should have no current vectors");
    });

    check("re-embed counting, stats, sample and price SQL run", () => {
      const remaining = Number(mustPsql(stmt("count_remaining")));
      assert(remaining === count("SELECT count(*) FROM chunks"), `remaining ${remaining}`);
      const [rows, chars] = mustPsql(stmt("remaining_stats")).split("|").map(Number);
      assert(rows === remaining && chars > 0, `stats ${rows}/${chars}`);
      assert(mustPsql(stmt("sample_texts")).split("\n").length === 10, "sample should return 10 rows");
      mustPsql(stmt("price"));
    });
  }

  check("033 down removes only embedding_jobs; 032 objects and data stay; up re-applies cleanly", () => {
    applyMigration("033_embedding_jobs.js", "down");
    assert(count("SELECT count(*) FROM information_schema.tables WHERE table_name = 'embedding_jobs'") === 0, "embedding_jobs still there");
    assert(count("SELECT count(*) FROM information_schema.tables WHERE table_name IN ('embedding_spaces','embedding_active_space','chunk_embeddings')") === 3, "a 032 table is gone");
    assert(count(`SELECT count(*) FROM chunk_embeddings WHERE space_id = '${legacy}'`) > 0, "legacy vectors lost");
    applyMigration("033_embedding_jobs.js", "up");
    applyMigration("033_embedding_jobs.js", "up"); // a second up is a no-op
    assert(count("SELECT count(*) FROM embedding_jobs") === 0, "fresh table expected after down/up");
  });
}

function main() {
  const version = docker(["version", "--format", "{{.Server.Version}}"]);
  if (version.status !== 0) {
    console.error("Docker daemon not available: up/down and EXPLAIN were NOT run.");
    process.exit(2);
  }
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  try {
    startContainer();
    const files = migrationFiles();
    const toApply = files.filter((f) => f < "032");
    console.log(`Applying ${toApply.length} migrations (${toApply[0]} .. ${toApply[toApply.length - 1]})`);
    for (const file of toApply) applyMigration(file, "up");
    seed();
    createRoles();
    runChecks();
  } catch (error) {
    console.log(`HARNESS ERROR  ${error.message}`);
    results.push({ name: "harness", ok: false });
  } finally {
    cleanup();
  }
  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
