// node --test cdk/lambda/db_setup/tests/analyticsArchive.test.js
// Shape checks on migration 048 with a fake `pgm`. Behavior against a real
// Postgres is checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/048_analytics_archive");

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

test("creates the anonymous id sequence and a counts-only archive table", () => {
  assert.match(up, /CREATE SEQUENCE IF NOT EXISTS analytics_archive_user_seq AS bigint/);
  assert.match(up, /CREATE TABLE IF NOT EXISTS analytics_archive \(/);
  assert.match(up, /PRIMARY KEY \(archive_user_id, activity_date\)/);
  for (const column of ["sessions_created", "messages", "questions", "thumbs_up", "thumbs_down"]) {
    assert.match(up, new RegExp(`${column} integer NOT NULL DEFAULT 0 CHECK \\(${column} >= 0\\)`), column);
  }
  const table = up.slice(up.indexOf("CREATE TABLE IF NOT EXISTS analytics_archive"), up.indexOf("CREATE INDEX"));
  // No link back to users and nothing textual.
  assert.doesNotMatch(table, /REFERENCES|(^|[\s(,])user_id\b|text|varchar|jsonb/);
  assert.match(up, /CREATE INDEX IF NOT EXISTS idx_analytics_archive_activity_date ON analytics_archive \(activity_date\)/);
});

test("grants readwrite DML and sequence usage when the role exists", () => {
  assert.match(up, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'readwrite'\)/);
  assert.match(up, /GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_archive TO readwrite/);
  assert.match(up, /GRANT USAGE ON SEQUENCE analytics_archive_user_seq TO readwrite/);
});

test("down drops the table and the sequence", () => {
  assert.match(down, /DROP TABLE IF EXISTS analytics_archive/);
  assert.match(down, /DROP SEQUENCE IF EXISTS analytics_archive_user_seq/);
});
