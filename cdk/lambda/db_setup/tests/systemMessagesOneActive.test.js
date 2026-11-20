// node --test cdk/lambda/db_setup/tests/systemMessagesOneActive.test.js
// Shape checks on migration 050 (finding f-e1a8b540) with a fake `pgm`.
// Behavior against a real Postgres is checked by tests/docker_migration_check.js
// (manual harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/050_system_messages_one_active");

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

test("up locks the table, keeps the newest active version per type, then adds the partial unique index", () => {
  const lock = up.indexOf("LOCK TABLE system_messages IN SHARE ROW EXCLUSIVE MODE");
  const repair = up.indexOf("UPDATE system_messages");
  const index = up.indexOf(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_system_messages_active ON system_messages (type) WHERE is_active"
  );
  assert.ok(lock >= 0 && repair > lock && index > repair, up);
  assert.match(up, /PARTITION BY type ORDER BY version DESC/);
  assert.match(up, /SET is_active = false/);
  assert.match(up, /rn > 1/);
});

test("down drops only the index", () => {
  assert.match(down, /DROP INDEX IF EXISTS uq_system_messages_active/);
  assert.doesNotMatch(down, /UPDATE|DELETE/);
});
