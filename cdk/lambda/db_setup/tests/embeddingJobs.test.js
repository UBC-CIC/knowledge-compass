// node --test cdk/lambda/db_setup/tests/embeddingJobs.test.js
// Shape checks on migration 033 with a fake `pgm`. Behavior against a real
// Postgres is checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/033_embedding_jobs");

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

test("exports up and down, and both only call pgm.sql", () => {
  assert.equal(typeof migration.up, "function");
  assert.equal(typeof migration.down, "function");
  assert.ok(up.length > 0 && down.length > 0);
});

test("embedding_jobs has the specified columns, defaults and references", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS embedding_jobs/);
  assert.match(up, /space_id\s+uuid\s+NOT NULL REFERENCES embedding_spaces\(id\)/);
  assert.match(up, /processed\s+integer\s+NOT NULL DEFAULT 0/);
  assert.match(up, /failed\s+integer\s+NOT NULL DEFAULT 0/);
  assert.match(up, /est_tokens\s+bigint\s+NULL/);
  assert.match(up, /est_cost_usd\s+numeric\(14,4\)\s+NULL/);
  assert.match(up, /est_seconds\s+integer\s+NULL/);
  assert.match(up, /price_configured\s+boolean\s+NOT NULL DEFAULT false/);
  assert.match(up, /cursor\s+text\s+NULL/);
  assert.match(up, /continuation\s+integer\s+NOT NULL DEFAULT 0/);
  assert.match(up, /current_step\s+varchar\(32\)\s+NULL/);
  assert.match(up, /steps\s+jsonb\s+NOT NULL DEFAULT '\[\]'/);
  assert.match(up, /report\s+jsonb\s+NULL/);
  assert.match(up, /last_error\s+text\s+NULL/);
  assert.match(up, /status\s+varchar\(16\)\s+NOT NULL DEFAULT 'queued'/);
});

test("mode and status CHECK constraints list every state", () => {
  assert.match(
    up,
    /CHECK \(mode IN \('dry_run', 'rebuild', 'delta', 'validate', 'activate', 'rollback'\)\)/
  );
  assert.match(up, /CHECK \(status IN \('queued', 'running', 'succeeded', 'failed', 'cancelled'\)\)/);
});

test("partial unique indexes enforce one active rebuild per space and one cutover overall", () => {
  assert.match(
    up,
    /CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_one_active_rebuild\s+ON embedding_jobs \(space_id\)\s+WHERE mode IN \('rebuild', 'delta'\) AND status IN \('queued', 'running'\)/
  );
  assert.match(
    up,
    /CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_one_active_cutover\s+ON embedding_jobs \(\(1\)\)\s+WHERE mode IN \('activate', 'rollback'\) AND status IN \('queued', 'running'\)/
  );
  assert.match(up, /ON embedding_jobs \(space_id, created_at DESC\)/);
});

test("up is idempotent in form and never touches migration 032 objects", () => {
  assert.doesNotMatch(up, /ALTER TABLE|DROP /i);
  assert.doesNotMatch(up, /CREATE TABLE(?! IF NOT EXISTS)/);
  assert.doesNotMatch(up, /CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/);
});

test("down drops only embedding_jobs", () => {
  assert.match(down, /DROP TABLE IF EXISTS embedding_jobs/);
  assert.doesNotMatch(down, /embedding_spaces|chunk_embeddings|embedding_active_space/);
});
