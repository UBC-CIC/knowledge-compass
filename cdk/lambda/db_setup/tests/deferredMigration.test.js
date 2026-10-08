// node --test cdk/lambda/db_setup/tests/deferredMigration.test.js
// The deferred cleanup migration must exist, stay outside migrations/, be impossible for
// the runner to apply by accident, and have a `down` that restores the column and index.
// Behavior against a real Postgres is checked by tests/docker_migration_check.js --deferred.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DB_SETUP = path.join(__dirname, "..");
const CDK_ROOT = path.join(DB_SETUP, "..", "..");
const FILE = "NNN_drop_legacy_embedding_column.js";
const DEFERRED_PATH = path.join(DB_SETUP, "deferred", FILE);
const migration = require(DEFERRED_PATH);

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

function withApproval(value, fn) {
  const saved = process.env[migration.APPROVAL_ENV];
  if (value === undefined) delete process.env[migration.APPROVAL_ENV];
  else process.env[migration.APPROVAL_ENV] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[migration.APPROVAL_ENV];
    else process.env[migration.APPROVAL_ENV] = saved;
  }
}

test("exports up and down", () => {
  assert.equal(typeof migration.up, "function");
  assert.equal(typeof migration.down, "function");
});

test("lives in deferred/, never in migrations/", () => {
  assert.ok(fs.existsSync(DEFERRED_PATH));
  assert.ok(!fs.existsSync(path.join(DB_SETUP, "migrations", FILE)));
  const inMigrations = fs.readdirSync(path.join(DB_SETUP, "migrations")).filter((name) => /drop_legacy_embedding/.test(name));
  assert.deepEqual(inMigrations, []);
  assert.ok(fs.existsSync(path.join(DB_SETUP, "deferred", "README.md")), "approval-gate README is missing");
});

test("the placeholder prefix cannot be taken for a numbered migration", () => {
  assert.ok(!/^\d{3}_/.test(FILE));
  assert.match(FILE, /^NNN_/);
});

test("the runner reads migrations/ only and nothing references the deferred file", () => {
  const index = fs.readFileSync(path.join(DB_SETUP, "index.js"), "utf8");
  assert.match(index, /dir:\s*path\.join\(__dirname,\s*"migrations"\)/);
  assert.doesNotMatch(index, /deferred/);
  for (const dir of ["bin", "lib"]) {
    for (const name of fs.readdirSync(path.join(CDK_ROOT, dir)).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(CDK_ROOT, dir, name), "utf8");
      assert.doesNotMatch(source, /db_setup\/deferred|drop_legacy_embedding/, `${dir}/${name} references the deferred migration`);
    }
  }
});

test("up refuses to run without the explicit approval value", () => {
  for (const value of [undefined, "", "yes", "true", "1", "drop-legacy-embedding-column "]) {
    withApproval(value, () => {
      assert.throws(() => run("up"), /not approved/, `approval value ${JSON.stringify(value)} was accepted`);
    });
  }
});

test("up, once approved, checks for data loss and drops trigger, function, index and column", () => {
  const up = withApproval(migration.APPROVAL_VALUE, () => run("up"));
  assert.match(up, /RAISE EXCEPTION/);
  assert.match(up, /DROP TRIGGER IF EXISTS trg_chunks_mirror_legacy_embedding ON chunks/);
  assert.match(up, /DROP FUNCTION IF EXISTS chunks_mirror_legacy_embedding\(\)/);
  assert.match(up, /DROP INDEX IF EXISTS idx_chunks_embedding_hnsw/);
  assert.match(up, /ALTER TABLE chunks DROP COLUMN IF EXISTS embedding/);
  // The data-loss check comes before anything is dropped.
  assert.ok(up.indexOf("RAISE EXCEPTION") < up.indexOf("DROP TRIGGER"));
});

test("down needs no approval and restores the column, the index, the function and the trigger", () => {
  const down = withApproval(undefined, () => run("down"));
  assert.match(down, /ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding vector\(1024\)/);
  assert.match(down, /CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw\s+ON chunks USING hnsw \(embedding vector_cosine_ops\)/);
  assert.match(down, /CREATE OR REPLACE FUNCTION chunks_mirror_legacy_embedding\(\)/);
  assert.match(down, /CREATE TRIGGER trg_chunks_mirror_legacy_embedding/);
});

test("down backfills from the legacy space's current vectors, before the index and trigger exist", () => {
  const down = run("down");
  assert.match(down, /UPDATE chunks c\s+SET embedding = ce\.embedding::vector\(1024\)/);
  assert.match(down, /ce\.embed_hash = md5\(c\.embed_text\)/);
  assert.match(down, /s\.name = 'cohere-v3-1024'/);
  assert.ok(down.indexOf("UPDATE chunks c") < down.indexOf("CREATE INDEX"));
  assert.ok(down.indexOf("CREATE INDEX") < down.indexOf("CREATE TRIGGER"));
});

test("the header carries the approval-gate warning", () => {
  const source = fs.readFileSync(DEFERRED_PATH, "utf8");
  assert.match(source, /DEFERRED/);
  assert.match(source, /DO NOT MOVE INTO migrations\/ UNTIL SEPARATELY APPROVED/);
});
