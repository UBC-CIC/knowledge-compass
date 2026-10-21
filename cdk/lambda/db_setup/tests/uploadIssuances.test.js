// node --test cdk/lambda/db_setup/tests/uploadIssuances.test.js
// Shape checks on migration 045 with a fake `pgm`. Behavior against a real Postgres is
// checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/045_upload_issuances");

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

test("one row per issued object, bound to the issuing admin", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS upload_issuances/);
  assert.match(up, /s3_bucket varchar\(255\) NOT NULL/);
  assert.match(up, /s3_key varchar\(1024\) NOT NULL/);
  assert.match(up, /issued_to_sub varchar\(128\) NOT NULL/);
  assert.match(up, /expires_at timestamptz NOT NULL/);
  assert.match(up, /consumed_at timestamptz NULL/);
  assert.match(up, /PRIMARY KEY \(s3_bucket, s3_key\)/);
});

test("indexes expires_at for the purge", () => {
  assert.match(up, /CREATE INDEX IF NOT EXISTS upload_issuances_expires_at_idx\s+ON upload_issuances \(expires_at\)/);
});

test("grants readwrite DML, guarded on the role existing", () => {
  assert.match(
    up,
    /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'readwrite'\) THEN\s+GRANT SELECT, INSERT, UPDATE, DELETE ON upload_issuances TO readwrite;/
  );
});

test("down drops the table", () => {
  assert.match(down, /DROP TABLE IF EXISTS upload_issuances/);
});
