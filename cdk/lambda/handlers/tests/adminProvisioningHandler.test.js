/**
 * Unit tests for handlers/adminProvisioningHandler.js (POST /admin/users)
 * with fake SQL and Cognito clients. No database or AWS:
 *
 *   node --test cdk/lambda/handlers/tests/adminProvisioningHandler.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler, quietly } = require("./_loadHandler.js");

const ADMIN_SUB = "11111111-2222-3333-4444-555555555555";
const NEW_SUB = "99999999-8888-7777-6666-555555555555";
const adminContext = {
  authorizer: { role: "admin", email: "admin@example.com", userId: ADMIN_SUB },
  requestId: "req-1",
};

process.env.USER_POOL_ID = "ca-central-1_TestPool";
// The handler reads the staff domain allow-list from this SSM parameter.
const DOMAINS_PARAM = "/test/KC/AllowedEmailDomains";
process.env.ALLOWED_EMAIL_DOMAINS = DOMAINS_PARAM;
const allowDomains = (value) => ({ [DOMAINS_PARAM]: value });

// Records every Cognito call; `overrides[name]` replaces a command's behaviour.
function fakeCognito(overrides = {}) {
  const calls = [];
  const cognito = (name, input) => {
    calls.push({ name, input });
    if (overrides[name]) return overrides[name](input);
    if (name === "AdminCreateUser") {
      return { User: { Attributes: [{ Name: "sub", Value: NEW_SUB }, { Name: "email", Value: input.Username }] } };
    }
    return {};
  };
  cognito.calls = calls;
  return cognito;
}

// A users table with no row for the new sub: ensureStaffUser inserts one.
const newRowSql = () =>
  fakeSql((text, values) =>
    text.startsWith("INSERT INTO users") ? [{ id: "new-admin", email: values[1], role: values[3] }] : []
  );

async function invoke(sql, cognito, event, ssmParameters = allowDomains("example.com")) {
  const { handler } = loadHandler("adminProvisioningHandler", sql, { cognito, ssmParameters });
  const res = await quietly(() => handler({ httpMethod: "POST", resource: "/admin/users", ...event }));
  return { statusCode: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null };
}

const post = (sql, cognito, body, requestContext = adminContext, ssmParameters) =>
  invoke(sql, cognito, { requestContext, body: JSON.stringify(body) }, ssmParameters);

// AdminCreateUser reports the account exists; AdminGetUser returns its sub.
const existingAccountCognito = () =>
  fakeCognito({
    AdminCreateUser: () => {
      const error = new Error("User account already exists");
      error.name = "UsernameExistsException";
      throw error;
    },
    AdminGetUser: () => ({ UserAttributes: [{ Name: "sub", Value: NEW_SUB }] }),
  });

test("creates the Cognito user, adds it to the admin group, and writes an admin users row with an audit", async () => {
  const sql = newRowSql();
  const cognito = fakeCognito();
  const res = await post(sql, cognito, { display_name: "New Admin", email: "  New@Example.COM " });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body, {
    id: "new-admin",
    email: "new@example.com",
    display_name: "New Admin",
    role: "admin",
    cognito: "created",
  });

  const [create, addToGroup] = cognito.calls;
  assert.equal(create.name, "AdminCreateUser");
  assert.equal(create.input.UserPoolId, "ca-central-1_TestPool");
  assert.equal(create.input.Username, "new@example.com");
  assert.deepEqual(create.input.DesiredDeliveryMediums, ["EMAIL"]);
  assert.deepEqual(addToGroup, {
    name: "AdminAddUserToGroup",
    input: { UserPoolId: "ca-central-1_TestPool", Username: "new@example.com", GroupName: "admin" },
  });

  const insert = sql.queries().find((q) => q.text.startsWith("INSERT INTO users"));
  assert.ok(insert.text.includes("'cognito'"));
  assert.equal(insert.values[1], "new@example.com");
  assert.equal(insert.values[3], "admin");
  assert.equal(insert.values[4], NEW_SUB);

  const audit = sql.queries().find((q) => q.text.startsWith("INSERT INTO admin_audit"));
  assert.equal(audit.values[0], ADMIN_SUB, "the actor is the calling admin, not the new one");
  assert.equal(audit.values[2], "admin_user.create");
  assert.deepEqual(JSON.parse(audit.values[3]), { user_id: "new-admin", outcome: "created", cognito: "created" });
});

test("an existing Cognito account is added to the admin group and its row elevated (200)", async () => {
  const sql = fakeSql((text, values) => {
    if (text.includes("FROM users WHERE cognito_sub")) return [{ id: "old-row", email: "new@example.com", role: "student" }];
    if (text.startsWith("UPDATE users")) return [{ id: "old-row", email: values[1], role: values[0] }];
    return [];
  });
  const cognito = fakeCognito({
    AdminCreateUser: () => {
      const error = new Error("User account already exists");
      error.name = "UsernameExistsException";
      throw error;
    },
    AdminGetUser: () => ({ UserAttributes: [{ Name: "sub", Value: NEW_SUB }] }),
  });
  const res = await post(sql, cognito, { display_name: "New Admin", email: "new@example.com" });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.role, "admin");
  assert.equal(res.body.cognito, "existing");
  assert.deepEqual(cognito.calls.map((c) => c.name), ["AdminCreateUser", "AdminGetUser", "AdminAddUserToGroup"]);
  const lookup = sql.queries().find((q) => q.text.includes("FROM users WHERE cognito_sub"));
  assert.deepEqual(lookup.values, [NEW_SUB]);
  const elevate = sql.queries().find((q) => q.text.startsWith("UPDATE users"));
  assert.equal(elevate.values[0], "admin");
  const audit = sql.queries().find((q) => q.text.startsWith("INSERT INTO admin_audit"));
  assert.deepEqual(JSON.parse(audit.values[3]), { user_id: "old-row", outcome: "existing", cognito: "existing" });
});

test("an email domain rejected by the pre-sign-up trigger is 400 and writes nothing", async () => {
  // The handler's own check passes; the trigger is the backstop.
  const sql = newRowSql();
  const cognito = fakeCognito({
    AdminCreateUser: () => {
      const error = new Error("PreSignUp failed with error Error validating email domain during pre-signup.");
      error.name = "UserLambdaValidationException";
      throw error;
    },
  });
  const res = await post(
    sql,
    cognito,
    { display_name: "Outsider", email: "someone@elsewhere.test" },
    adminContext,
    allowDomains("example.com,elsewhere.test")
  );
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Email domain is not allowed" });
  assert.deepEqual(cognito.calls.map((c) => c.name), ["AdminCreateUser"]);
  assert.equal(sql.queries().length, 0);
});

test("an address outside the allow-list is 400 before Cognito, whether or not its account exists", async () => {
  for (const [label, cognito] of [
    ["existing account", existingAccountCognito()],
    ["new account", fakeCognito()],
  ]) {
    const sql = newRowSql();
    const res = await post(sql, cognito, { display_name: "Revoked", email: "old.admin@revoked.test" });
    assert.equal(res.statusCode, 400, label);
    assert.deepEqual(res.body, { error: "Email domain is not allowed" }, label);
    assert.equal(cognito.calls.length, 0, `${label}: no Cognito call, so no group grant`);
    assert.equal(sql.queries().length, 0, `${label}: no users row or audit row`);
  }
});

test("a subdomain of an allowed domain is not allowed", async () => {
  const cognito = existingAccountCognito();
  const res = await post(newRowSql(), cognito, { display_name: "Sub", email: "someone@mail.example.com" });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Email domain is not allowed" });
  assert.equal(cognito.calls.length, 0);
});

test("allow-list entries are compared trimmed and lower-cased", async () => {
  const cognito = fakeCognito();
  const res = await post(
    newRowSql(),
    cognito,
    { display_name: "New Admin", email: "new@example.com" },
    adminContext,
    allowDomains(" other.org , Example.COM ")
  );
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
});

test("an empty allow-list refuses every address", async () => {
  for (const value of ["", " , "]) {
    const cognito = existingAccountCognito();
    const sql = newRowSql();
    const res = await post(sql, cognito, { display_name: "New", email: "new@example.com" }, adminContext, allowDomains(value));
    assert.equal(res.statusCode, 400, JSON.stringify(value));
    assert.deepEqual(res.body, { error: "Email domain is not allowed" });
    assert.equal(cognito.calls.length, 0);
    assert.equal(sql.queries().length, 0);
  }
});

test("an unreadable allow-list is 500 and grants nothing", async () => {
  const cognito = existingAccountCognito();
  const sql = newRowSql();
  const res = await post(
    sql,
    cognito,
    { display_name: "New", email: "new@example.com" },
    adminContext,
    allowDomains(new Error("AccessDeniedException"))
  );
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Internal server error" });
  assert.equal(cognito.calls.length, 0);
  assert.equal(sql.queries().length, 0);

  const saved = process.env.ALLOWED_EMAIL_DOMAINS;
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  try {
    const unset = existingAccountCognito();
    const resUnset = await post(newRowSql(), unset, { display_name: "New", email: "new@example.com" });
    assert.equal(resUnset.statusCode, 500);
    assert.equal(unset.calls.length, 0);
  } finally {
    process.env.ALLOWED_EMAIL_DOMAINS = saved;
  }
});

test("invalid input is 400 before any Cognito or database call", async () => {
  for (const body of [
    { display_name: "New", email: "   " },
    { display_name: "  ", email: "new@example.com" },
    { email: "new@example.com" },
    { display_name: "New", email: "not-an-email" },
    { display_name: "x".repeat(256), email: "new@example.com" },
  ]) {
    const sql = newRowSql();
    const cognito = fakeCognito();
    const res = await post(sql, cognito, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(cognito.calls.length, 0);
    assert.equal(sql.calls.length, 0);
  }

  const sql = newRowSql();
  const cognito = fakeCognito();
  const res = await invoke(sql, cognito, { requestContext: adminContext, body: "{not json" });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid JSON body" });
  assert.equal(cognito.calls.length, 0);
});

test("non-admins are 403, a missing sub is 401, other routes are 404, all before Cognito", async () => {
  const body = { display_name: "New", email: "new@example.com" };
  for (const requestContext of [undefined, {}, { authorizer: { role: "user", userId: ADMIN_SUB } }]) {
    const cognito = fakeCognito();
    const res = await invoke(newRowSql(), cognito, { requestContext, body: JSON.stringify(body) });
    assert.equal(res.statusCode, 403);
    assert.equal(cognito.calls.length, 0);
  }

  const noSub = fakeCognito();
  const res401 = await post(newRowSql(), noSub, body, { authorizer: { role: "admin", email: "admin@example.com" } });
  assert.equal(res401.statusCode, 401);
  assert.equal(noSub.calls.length, 0);

  const other = fakeCognito();
  const res404 = await invoke(newRowSql(), other, {
    httpMethod: "GET",
    resource: "/admin/users",
    requestContext: adminContext,
  });
  assert.equal(res404.statusCode, 404);
  assert.equal(other.calls.length, 0);
});

test("an unexpected Cognito failure is 500 and logs no email", async () => {
  const sql = newRowSql();
  const cognito = fakeCognito({
    AdminAddUserToGroup: () => {
      const error = new Error("User new@example.com is throttled");
      error.name = "TooManyRequestsException";
      throw error;
    },
  });
  const { handler } = loadHandler("adminProvisioningHandler", sql, {
    cognito,
    ssmParameters: allowDomains("example.com"),
  });
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...args) => lines.push(JSON.stringify(args));
  let res;
  try {
    res = await handler({
      httpMethod: "POST",
      resource: "/admin/users",
      requestContext: adminContext,
      body: JSON.stringify({ display_name: "New", email: "new@example.com" }),
    });
  } finally {
    Object.assign(console, saved);
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: "Internal server error" });
  // The grant comes last: the audit row already committed when it failed.
  assert.ok(sql.queries().some((q) => q.text.startsWith("INSERT INTO admin_audit")), "audited before the grant");
  assert.ok(!lines.some((l) => l.includes("new@example.com")), "email never logged");
});

test("a database failure leaves the account outside the admin group (no unaudited admin)", async () => {
  const sql = fakeSql((text) => {
    if (text.startsWith("INSERT INTO admin_audit")) throw new Error("db down");
    return text.startsWith("INSERT INTO users") ? [{ id: "new-admin", email: "new@example.com", role: "admin" }] : [];
  });
  const cognito = fakeCognito();
  const res = await post(sql, cognito, { display_name: "New", email: "new@example.com" });
  assert.equal(res.statusCode, 500);
  assert.ok(!cognito.calls.some((c) => c.name === "AdminAddUserToGroup"));
});
