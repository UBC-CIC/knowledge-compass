// node --test cdk/lambda/db_setup/tests/serviceStatus.test.js
// Shape checks on migration 034 with a fake `pgm`. Behavior against a real Postgres is
// checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/034_service_status");

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

test("adds the two columns with a default so existing rows need no backfill", () => {
  assert.match(up, /ADD COLUMN IF NOT EXISTS service_status\s+varchar\(16\) NOT NULL DEFAULT 'normal'/);
  assert.match(up, /ADD COLUMN IF NOT EXISTS service_message text NULL/);
});

test("guards the CHECK constraints with the pg_constraint pattern (re-appliable)", () => {
  assert.match(up, /pg_constraint WHERE conname = 'system_settings_service_status_check'/);
  assert.match(up, /CHECK \(service_status IN \('normal', 'banner', 'read_only'\)\)/);
  assert.match(up, /pg_constraint WHERE conname = 'system_settings_service_message_check'/);
  assert.match(up, /CHECK \(char_length\(service_message\) <= 500\)/);
});

test("down drops the constraints and both columns", () => {
  assert.match(down, /DROP CONSTRAINT IF EXISTS system_settings_service_message_check/);
  assert.match(down, /DROP CONSTRAINT IF EXISTS system_settings_service_status_check/);
  assert.match(down, /DROP COLUMN IF EXISTS service_message/);
  assert.match(down, /DROP COLUMN IF EXISTS service_status/);
});
