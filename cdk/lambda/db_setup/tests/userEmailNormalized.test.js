// node --test cdk/lambda/db_setup/tests/userEmailNormalized.test.js
// Shape checks on migration 041 with a fake `pgm`. Behavior against a real
// Postgres is checked by tests/docker_migration_check.js (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/041_user_email_normalized");

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

test("folds emails and keeps one row per folded value, preferring an admin", () => {
  assert.match(up, /lower\(btrim\(email\)\) AS folded/);
  assert.match(up, /PARTITION BY lower\(btrim\(email\)\)/);
  assert.match(
    up,
    /ORDER BY \(role = 'admin'::user_role\) DESC, \(identity_source = 'cognito'\) DESC, \(cognito_sub IS NOT NULL\) DESC, created_at ASC NULLS LAST, id ASC/
  );
  assert.match(up, /SET email = CASE WHEN r\.rn = 1 THEN r\.folded ELSE NULL END/);
  assert.match(up, /SET email = NULL WHERE email IS NOT NULL AND btrim\(email\) = ''/);
});

test("replaces the case-sensitive unique with a unique index on lower(email)", () => {
  assert.match(up, /ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key/);
  assert.match(up, /c\.contype = 'u'/);
  assert.match(up, /a\.attname = 'email'/);
  assert.match(up, /CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users \(lower\(email\)\)/);
  const drop = up.indexOf("DROP CONSTRAINT IF EXISTS users_email_key");
  const index = up.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key");
  const fold = up.indexOf("SET email = CASE WHEN r.rn = 1");
  assert.ok(fold >= 0 && fold < drop && drop < index, "fold existing rows before the new unique index");
});

test("rejects a stored email that is not already trimmed and lowercase", () => {
  assert.match(
    up,
    /ADD CONSTRAINT users_email_lowercase_check CHECK \(email IS NULL OR email = lower\(btrim\(email\)\)\)/
  );
  assert.match(up, /EXCEPTION WHEN duplicate_object THEN null/);
  const index = up.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key");
  const check = up.indexOf("users_email_lowercase_check");
  assert.ok(index >= 0 && index < check);
});

test("down restores the column unique and leaves folded data in place", () => {
  assert.match(down, /DROP CONSTRAINT IF EXISTS users_email_lowercase_check/);
  assert.match(down, /DROP INDEX IF EXISTS users_email_lower_key/);
  assert.match(down, /ADD CONSTRAINT users_email_key UNIQUE \(email\)/);
  assert.doesNotMatch(down, /SET email/i);
  const dropCheck = down.indexOf("DROP CONSTRAINT IF EXISTS users_email_lowercase_check");
  const dropIndex = down.indexOf("DROP INDEX IF EXISTS users_email_lower_key");
  const addUnique = down.indexOf("ADD CONSTRAINT users_email_key");
  assert.ok(dropCheck < dropIndex && dropIndex < addUnique);
});
