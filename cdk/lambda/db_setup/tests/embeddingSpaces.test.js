// node --test cdk/lambda/db_setup/tests/embeddingSpaces.test.js
// Shape checks on migration 032 with a fake `pgm`. Behavior against a real
// Postgres is checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const migration = require("../migrations/032_embedding_spaces");

function run(direction) {
  const calls = [];
  const pgm = new Proxy(
    { sql: (text) => calls.push(text) },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        throw new Error(`migration used pgm.${String(prop)}; only pgm.sql is allowed`);
      },
    }
  );
  migration[direction](pgm);
  return calls.join("\n");
}

const up = run("up");
const down = run("down");
// Strip SQL comments so assertions do not match prose.
const code = (sql) => sql.replace(/--.*$/gm, "");

test("exports up and down, and both only call pgm.sql", () => {
  assert.equal(typeof migration.up, "function");
  assert.equal(typeof migration.down, "function");
  assert.ok(up.length > 0 && down.length > 0);
});

test("price and EOL date are nullable, with no NOT NULL on them", () => {
  assert.match(up, /price_per_1m_tokens\s+numeric\(12,4\)\s+NULL CHECK \(price_per_1m_tokens >= 0\)/);
  assert.match(up, /eol_date\s+date\s+NULL/);
  assert.doesNotMatch(up, /price_per_1m_tokens[^\n]*NOT NULL/);
  assert.doesNotMatch(up, /eol_date[^\n]*NOT NULL/);
});

test("status CHECK lists the five lifecycle states", () => {
  assert.match(
    up,
    /CHECK \(status IN \('building', 'validated', 'active', 'retired', 'purged'\)\)/
  );
});

test("creates the three tables with the specified keys", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS embedding_spaces/);
  assert.match(up, /CREATE TABLE IF NOT EXISTS embedding_active_space/);
  assert.match(up, /id\s+integer\s+PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)/);
  assert.match(up, /cutover_locked_at\s+timestamptz\s+NULL/);
  assert.match(up, /cutover_job_id\s+uuid\s+NULL/);
  assert.match(up, /CREATE TABLE IF NOT EXISTS chunk_embeddings/);
  assert.match(up, /PRIMARY KEY \(chunk_id, space_id\)/);
  assert.match(up, /REFERENCES chunks\(id\) ON DELETE CASCADE/);
  assert.match(up, /embedding\s+vector\s+NOT NULL/);
  assert.match(up, /dimensions\s+integer\s+NOT NULL CHECK \(dimensions BETWEEN 1 AND 2000\)/);
  assert.match(up, /settings\s+jsonb\s+NOT NULL DEFAULT '\{\}'/);
  assert.match(up, /chunk_embeddings_space_idx/);
});

test("index functions are SECURITY DEFINER with a fixed search_path and no PUBLIC access", () => {
  for (const fn of ["create_space_index", "drop_space_index"]) {
    const re = new RegExp(`FUNCTION ${fn}\\(p_space_id uuid\\)[\\s\\S]*?SECURITY DEFINER\\s+SET search_path = public, pg_temp`);
    assert.match(up, re, fn);
    assert.match(up, new RegExp(`REVOKE ALL ON FUNCTION ${fn}\\(uuid\\) FROM PUBLIC`), fn);
  }
  assert.match(up, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'readwrite'\)/);
  assert.match(up, /GRANT EXECUTE ON FUNCTION create_space_index\(uuid\), drop_space_index\(uuid\) TO readwrite/);
});

test("index DDL quotes identifiers and literals and uses the registry dimension", () => {
  assert.match(up, /format\(\s*'CREATE INDEX IF NOT EXISTS %I ON chunk_embeddings USING hnsw \(\(embedding::vector\(%s\)\) vector_cosine_ops\) WHERE space_id = %L'/);
  assert.match(up, /v_name, v_dims, p_space_id/);
  assert.match(up, /SELECT dimensions, status INTO v_dims, v_status/);
  assert.match(up, /is active; its index cannot be dropped/);
  assert.match(up, /is purged/);
});

test("registers the legacy space as active, with defaults and a backfill", () => {
  assert.match(up, /'cohere-v3-1024', 'cohere_v3', 'cohere\.embed-english-v3', 'cohere\.embed-english-v3'/);
  assert.match(up, /1024, 'active', 0\.40, 0\.6, now\(\)/);
  assert.match(up, /ON CONFLICT \(name\) DO NOTHING/);
  assert.match(up, /INSERT INTO embedding_active_space \(id, space_id\)/);
  assert.match(up, /md5\(c\.embed_text\)/);
  assert.match(up, /WHERE c\.embedding IS NOT NULL/);
  assert.match(up, /SELECT create_space_index\(id\) FROM embedding_spaces WHERE name = 'cohere-v3-1024'/);
});

test("compatibility trigger mirrors only into the legacy space, by name", () => {
  assert.match(up, /AFTER INSERT OR UPDATE OF embedding ON chunks/);
  assert.match(up, /WHEN \(NEW\.embedding IS NOT NULL\)/);
  assert.match(up, /trg_chunks_mirror_legacy_embedding/);
  assert.match(up, /SELECT id INTO v_space FROM embedding_spaces WHERE name = 'cohere-v3-1024'/);
  assert.doesNotMatch(code(up), /embedding_active_space[\s\S]{0,40}v_space/);
});

test("up does not drop or alter chunks.embedding or its old index", () => {
  const sql = code(up);
  assert.doesNotMatch(sql, /ALTER TABLE\s+chunks/i);
  assert.doesNotMatch(sql, /DROP\s+COLUMN/i);
  assert.doesNotMatch(sql, /DROP INDEX[^;]*idx_chunks_embedding/i);
  assert.doesNotMatch(sql, /DROP TABLE/i);
});

test("down reverses everything it created and leaves chunks alone", () => {
  assert.match(down, /DROP TRIGGER IF EXISTS trg_chunks_mirror_legacy_embedding ON chunks/);
  assert.match(down, /DROP FUNCTION IF EXISTS chunks_mirror_legacy_embedding\(\)/);
  assert.match(down, /DROP FUNCTION IF EXISTS create_space_index\(uuid\)/);
  assert.match(down, /DROP FUNCTION IF EXISTS drop_space_index\(uuid\)/);
  assert.match(down, /DROP INDEX IF EXISTS %I/);
  assert.match(down, /idx_ce_hnsw_/);
  assert.match(down, /DROP TABLE IF EXISTS chunk_embeddings/);
  assert.match(down, /DROP TABLE IF EXISTS embedding_active_space/);
  assert.match(down, /DROP TABLE IF EXISTS embedding_spaces/);
  assert.doesNotMatch(code(down), /ALTER TABLE\s+chunks|DROP TABLE IF EXISTS chunks|idx_chunks_embedding/);
  // Dependent tables go before the tables they reference.
  assert.ok(down.indexOf("DROP TABLE IF EXISTS chunk_embeddings") < down.indexOf("DROP TABLE IF EXISTS embedding_spaces"));
  assert.ok(down.indexOf("DROP TABLE IF EXISTS embedding_active_space") < down.indexOf("DROP TABLE IF EXISTS embedding_spaces"));
});

test("db_setup/index.js grants the index functions to readwrite behind an existence guard", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /to_regprocedure\('create_space_index\(uuid\)'\) IS NOT NULL/);
  assert.match(source, /GRANT EXECUTE ON FUNCTION create_space_index\(uuid\), drop_space_index\(uuid\) TO readwrite/);
});
