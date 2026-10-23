// node --test cdk/lambda/db_setup/tests/guestEmailCleared.test.js
// Shape checks on migration 046 with a fake `pgm`. Behavior against a real
// Postgres is checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/046_guest_email_cleared");

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

test("clears email on guest student rows only", () => {
  assert.match(
    up,
    /UPDATE users SET email = NULL WHERE identity_source = 'guest' AND role = 'student'::user_role AND email IS NOT NULL;/
  );
  // Admin rows from POST /admin/users default to 'guest' and keep their address.
  assert.doesNotMatch(up, /role = 'admin'/);
});

test("adds the guest student email check after clearing existing values", () => {
  assert.match(
    up,
    /ADD CONSTRAINT users_guest_student_email_null CHECK \(identity_source <> 'guest' OR role <> 'student'::user_role OR email IS NULL\)/
  );
  assert.match(up, /EXCEPTION WHEN duplicate_object THEN null/);
  const clear = up.indexOf("SET email = NULL");
  const check = up.indexOf("ADD CONSTRAINT users_guest_student_email_null");
  assert.ok(clear >= 0 && clear < check);
});

test("down drops the check and does not touch email values", () => {
  assert.match(down, /ALTER TABLE users DROP CONSTRAINT IF EXISTS users_guest_student_email_null/);
  assert.doesNotMatch(down, /SET email/i);
});
