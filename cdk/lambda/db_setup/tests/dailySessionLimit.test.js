// node --test cdk/lambda/db_setup/tests/dailySessionLimit.test.js
// Shape checks on migration 047 with a fake `pgm`. Behavior against a real
// Postgres is checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/047_daily_session_limit");

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

test("adds a non-negative sessions_created counter defaulting to 0", () => {
  assert.match(up, /ALTER TABLE user_daily_usage ADD COLUMN IF NOT EXISTS sessions_created integer NOT NULL DEFAULT 0/);
  assert.match(
    up,
    /ADD CONSTRAINT user_daily_usage_sessions_created_check CHECK \(sessions_created >= 0\)/
  );
  assert.match(up, /EXCEPTION WHEN duplicate_object THEN null/);
});

test("down drops the constraint and the column", () => {
  assert.match(down, /DROP CONSTRAINT IF EXISTS user_daily_usage_sessions_created_check/);
  assert.match(down, /DROP COLUMN IF EXISTS sessions_created/);
});
