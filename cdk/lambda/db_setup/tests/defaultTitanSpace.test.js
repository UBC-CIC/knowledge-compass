// node --test cdk/lambda/db_setup/tests/defaultTitanSpace.test.js
// Shape checks on migration 049 with a fake `pgm`. Behavior against a real
// Postgres is checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/049_default_titan_space");

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
  return calls.join("\n").replace(/\s+/g, " ");
}

const up = run("up");
const down = run("down");

test("exports up and down, and both only call pgm.sql", () => {
  assert.equal(typeof migration.up, "function");
  assert.equal(typeof migration.down, "function");
  assert.ok(up.length > 0 && down.length > 0);
});

test("switches only an empty database whose active space is the legacy Cohere v3 one", () => {
  assert.match(up, /WHERE s\.name = 'cohere-v3-1024'; IF v_legacy IS NULL THEN RETURN;/);
  assert.match(up, /IF EXISTS \(SELECT 1 FROM chunks\) OR EXISTS \(SELECT 1 FROM chunk_embeddings\) THEN RETURN;/);
  // Both guards come before any write.
  const firstWrite = up.indexOf("INSERT INTO embedding_spaces");
  assert.ok(up.indexOf("FROM chunks") < firstWrite);
  assert.ok(up.indexOf("v_legacy IS NULL") < firstWrite);
});

test("registers Titan V2 at 1024 dimensions as active, with its index, and retires Cohere v3", () => {
  assert.match(
    up,
    /\('titan-v2-1024', 'titan_v2', 'amazon\.titan-embed-text-v2:0', 'amazon\.titan-embed-text-v2:0', 1024, 'active', now\(\)\)/
  );
  assert.match(up, /ON CONFLICT \(name\) DO NOTHING RETURNING id INTO v_titan; IF v_titan IS NULL THEN RETURN;/);
  assert.match(up, /PERFORM create_space_index\(v_titan\)/);
  assert.match(up, /SET status = 'retired', retired_at = now\(\) WHERE id = v_legacy/);
  assert.match(up, /UPDATE embedding_active_space SET space_id = v_titan/);
  // Never deletes the legacy space or touches stored vectors.
  assert.doesNotMatch(up, /DELETE|DROP|TRUNCATE/);
});

test("down reverts only an unused Titan space", () => {
  assert.match(down, /EXISTS \(SELECT 1 FROM chunk_embeddings WHERE space_id = v_titan\)/);
  assert.match(down, /EXISTS \(SELECT 1 FROM embedding_jobs WHERE space_id = v_titan\)/);
  assert.match(down, /UPDATE embedding_active_space SET space_id = v_legacy/);
  // The Titan space is retired (no longer active) before its index is dropped.
  assert.ok(down.indexOf("WHERE id = v_titan; PERFORM drop_space_index") > 0);
  assert.match(down, /DELETE FROM embedding_spaces WHERE id = v_titan/);
});
