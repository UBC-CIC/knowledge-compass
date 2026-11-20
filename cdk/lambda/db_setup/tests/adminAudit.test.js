// node --test cdk/lambda/db_setup/tests/adminAudit.test.js
// Shape checks on migration 040 with a fake `pgm`. Behavior against a real Postgres is
// checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/040_admin_audit");

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

test("creates admin_audit with a required actor and action", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS admin_audit/);
  assert.match(up, /id uuid PRIMARY KEY DEFAULT uuid_generate_v4\(\)/);
  assert.match(up, /actor_sub varchar\(128\) NOT NULL/);
  assert.match(up, /actor_email varchar\(320\) NULL/);
  assert.match(up, /action varchar\(64\) NOT NULL/);
  assert.match(up, /target jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(up, /request_id varchar\(128\) NULL/);
  assert.match(up, /created_at timestamptz NOT NULL DEFAULT now\(\)/);
});

test("indexes created_at and (actor_sub, created_at)", () => {
  assert.match(up, /CREATE INDEX IF NOT EXISTS admin_audit_created_at_idx\s+ON admin_audit \(created_at DESC\)/);
  assert.match(
    up,
    /CREATE INDEX IF NOT EXISTS admin_audit_actor_sub_created_at_idx\s+ON admin_audit \(actor_sub, created_at DESC\)/
  );
});

test("append-only triggers block UPDATE, DELETE and TRUNCATE (re-appliable)", () => {
  assert.match(up, /CREATE OR REPLACE FUNCTION admin_audit_append_only\(\)/);
  assert.match(up, /RAISE EXCEPTION 'admin_audit is append-only'/);
  assert.match(up, /DROP TRIGGER IF EXISTS admin_audit_no_update_delete ON admin_audit/);
  assert.match(up, /BEFORE UPDATE OR DELETE ON admin_audit\s+FOR EACH ROW EXECUTE FUNCTION admin_audit_append_only\(\)/);
  assert.match(up, /DROP TRIGGER IF EXISTS admin_audit_no_truncate ON admin_audit/);
  assert.match(up, /BEFORE TRUNCATE ON admin_audit\s+FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_append_only\(\)/);
});

test("grants readwrite only SELECT, INSERT, guarded on the role existing", () => {
  assert.match(up, /pg_roles WHERE rolname = 'readwrite'/);
  assert.match(up, /GRANT SELECT, INSERT ON admin_audit TO readwrite/);
  assert.doesNotMatch(up, /GRANT[^;]*(UPDATE|DELETE)[^;]*admin_audit/);
});

test("down drops the table (and its triggers) and the function", () => {
  assert.match(down, /DROP TABLE IF EXISTS admin_audit/);
  assert.match(down, /DROP FUNCTION IF EXISTS admin_audit_append_only\(\)/);
  assert.ok(down.indexOf("DROP TABLE") < down.indexOf("DROP FUNCTION"), "table before function");
});
