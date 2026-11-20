// node --test cdk/lambda/db_setup/tests/userIdentitySource.test.js
// Shape checks on migration 039 with a fake `pgm`.
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/039_user_identity_source");

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

test("adds identity_source and cognito_sub", () => {
  assert.match(up, /ADD COLUMN IF NOT EXISTS identity_source varchar\(16\)/);
  assert.match(up, /ADD COLUMN IF NOT EXISTS cognito_sub varchar\(128\)/);
});

test("staff backfill requires admin role, an email and no chat sessions", () => {
  assert.match(
    up,
    /SET identity_source = 'cognito' WHERE u\.identity_source IS NULL AND u\.role = 'admin'::user_role AND u\.email IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM chat_sessions s WHERE s\.user_id = u\.id\)/
  );
});

test("everything else becomes a guest, and staff credentials are revoked", () => {
  assert.match(up, /SET identity_source = 'guest' WHERE identity_source IS NULL/);
  assert.match(
    up,
    /SET credential_version = credential_version \+ 1, credential_rotated_at = NULL WHERE identity_source = 'cognito'/
  );
});

test("constraints: default/not null, allowed values, unique sub, sub only on cognito rows", () => {
  assert.match(up, /ALTER COLUMN identity_source SET DEFAULT 'guest', ALTER COLUMN identity_source SET NOT NULL/);
  assert.match(up, /users_identity_source_check CHECK \(identity_source IN \('guest', 'cognito'\)\)/);
  assert.match(up, /users_cognito_sub_key UNIQUE \(cognito_sub\)/);
  assert.match(up, /users_cognito_sub_requires_cognito CHECK \(cognito_sub IS NULL OR identity_source = 'cognito'\)/);
  assert.match(up, /EXCEPTION WHEN duplicate_object OR duplicate_table THEN null/);
});

test("order is add column, backfill, revoke, not null, constraints", () => {
  const add = up.indexOf("ADD COLUMN IF NOT EXISTS identity_source");
  const staff = up.indexOf("SET identity_source = 'cognito'");
  const guest = up.indexOf("SET identity_source = 'guest'");
  const revoke = up.indexOf("SET credential_version");
  const notNull = up.indexOf("SET NOT NULL");
  const constraint = up.indexOf("ADD CONSTRAINT");
  assert.ok(add >= 0 && add < staff && staff < guest && guest < revoke && revoke < notNull && notNull < constraint);
});

test("down drops the constraints and both columns", () => {
  assert.match(down, /DROP CONSTRAINT IF EXISTS users_cognito_sub_requires_cognito/);
  assert.match(down, /DROP CONSTRAINT IF EXISTS users_cognito_sub_key/);
  assert.match(down, /DROP CONSTRAINT IF EXISTS users_identity_source_check/);
  assert.match(down, /DROP COLUMN IF EXISTS cognito_sub/);
  assert.match(down, /DROP COLUMN IF EXISTS identity_source/);
});
