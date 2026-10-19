/**
 * Unit tests for the Cognito PostConfirmation trigger
 * (authorization/addAdminOnSignUp.js): the users row is keyed on the Cognito
 * sub, and a guest row that pre-claimed the email is never captured. Fake SQL
 * and AWS clients, no database:
 *
 *   node --test cdk/lambda/authorization/tests/addAdminOnSignUp.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const { fakeSql } = require("../../handlers/tests/_loadHandler.js");

const SUB = "11111111-2222-3333-4444-555555555555";
const ROW = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const GUEST = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c";
const EMAIL = "admin@staff.example";

function staffSql({ bySub = [], holders = [] } = {}) {
  const sql = fakeSql((text, values) => {
    if (text.startsWith("SELECT id, email, role FROM users WHERE cognito_sub")) return bySub;
    if (text.startsWith("SELECT id, identity_source, cognito_sub, role")) return holders;
    if (text.startsWith("UPDATE users SET email = NULL")) return holders.map((h) => ({ id: h.id }));
    if (text.startsWith("UPDATE users SET last_seen_at")) return [{ id: values[2], email: values[1], role: values[0] }];
    if (text.startsWith("INSERT INTO users")) return [{ id: values[0], email: values[1], role: values[3] }];
    return [];
  });
  sql.begin = async (fn) => fn(sql);
  return sql;
}

// Fresh-require the trigger wired to `sql`, with Cognito returning `groups`.
function loadTrigger(sql, groups = []) {
  const dir = path.resolve(__dirname, "..");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir) && !key.includes(`${path.sep}tests${path.sep}`)) delete require.cache[key];
  }
  class FakeCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const fakes = {
    postgres: () => sql,
    "@aws-sdk/client-secrets-manager": {
      SecretsManagerClient: class {
        async send() {
          throw new Error("unexpected Secrets Manager call");
        }
      },
      GetSecretValueCommand: FakeCommand,
    },
    "@aws-sdk/client-cognito-identity-provider": {
      CognitoIdentityProviderClient: class {
        async send() {
          return { Groups: groups.map((GroupName) => ({ GroupName })) };
        }
      },
      AdminListGroupsForUserCommand: FakeCommand,
    },
  };
  global.sqlConnection = sql;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(path.join(dir, "addAdminOnSignUp.js"));
  } finally {
    Module._load = originalLoad;
  }
}

const confirmEvent = (attributes) => ({
  userName: EMAIL,
  userPoolId: "pool",
  triggerSource: "PostConfirmation_ConfirmSignUp",
  request: { userAttributes: attributes },
});

async function run(sql, event, groups) {
  const { handler } = loadTrigger(sql, groups);
  const lines = [];
  const saved = { log: console.log, error: console.error };
  console.log = console.error = (...args) => lines.push(JSON.stringify(args));
  try {
    return { result: await handler(event), lines };
  } finally {
    Object.assign(console, saved);
    delete global.sqlConnection;
  }
}

test("an admin whose email a guest pre-claimed gets a new cognito row; the guest is detached", async () => {
  const sql = staffSql({
    holders: [{ id: GUEST, identity_source: "guest", cognito_sub: null, role: "student", has_sessions: true }],
  });
  const event = confirmEvent({ sub: SUB, email: "Admin@Staff.Example", given_name: "Pat", family_name: "Admin" });
  const { result, lines } = await run(sql, event, ["admin"]);
  assert.equal(result, event);

  const queries = sql.queries();
  assert.ok(!queries.some((q) => q.text.includes("ON CONFLICT (email)")));
  assert.ok(!queries.some((q) => q.text.startsWith("UPDATE users SET cognito_sub")), "guest row is never linked");
  const detach = queries.find((q) => q.text.startsWith("UPDATE users SET email = NULL"));
  assert.deepEqual(detach.values, [EMAIL]);
  const insert = queries.find((q) => q.text.startsWith("INSERT INTO users"));
  assert.ok(insert.text.includes("'cognito'"));
  assert.ok(insert.values.includes(SUB));
  assert.equal(insert.values[3], "admin");

  for (const line of lines) {
    assert.ok(!line.toLowerCase().includes(EMAIL) && !line.includes("Pat Admin"), line);
  }
  assert.ok(lines.some((l) => l.includes('"outcome":"created"')));
});

test("re-confirmation (sub hit) leaves the role untouched", async () => {
  const sql = staffSql({ bySub: [{ id: ROW, email: EMAIL, role: "student" }] });
  await run(sql, confirmEvent({ sub: SUB, email: EMAIL }), ["admin"]);
  const update = sql.queries().find((q) => q.text.startsWith("UPDATE users SET last_seen_at"));
  assert.equal(update.values[0], "student");
  assert.ok(!sql.queries().some((q) => q.text.startsWith("INSERT INTO users")));
});

test("a missing sub skips the database and still returns the event", async () => {
  const sql = staffSql();
  const event = confirmEvent({ email: EMAIL });
  const { result, lines } = await run(sql, event, ["admin"]);
  assert.equal(result, event);
  assert.equal(sql.queries().length, 0);
  for (const line of lines) assert.ok(!line.includes(EMAIL), line);
});
