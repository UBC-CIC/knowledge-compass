/**
 * Unit tests for handlers/userHandler.js routing, validation and chat history
 * ownership checks, using a fake SQL client. No database:
 *
 *   node --test cdk/lambda/handlers/tests/userHandler.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler, quietly } = require("./_loadHandler.js");

const USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const OTHER_USER = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c";
const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";
const HISTORY_ROUTE = "/user/{user_id}/chat_sessions/{chat_session_id}/chat_history";

// What the user authorizer sets for a token bound to `userId` ("" = anonymous).
const as = (userId) => ({ authorizer: { userId, role: "user" } });

// PUT /user reads the staff sign-up domains from this SSM parameter.
const STAFF_DOMAINS_PARAM = "/KC/AllowedEmailDomains";
process.env.ALLOWED_EMAIL_DOMAINS = STAFF_DOMAINS_PARAM;
const STAFF_SSM = { ssmParameters: { [STAFF_DOMAINS_PARAM]: " staff.example ,, Board.Example" } };

async function invoke(sql, event, options = STAFF_SSM) {
  const { handler } = loadHandler("userHandler", sql, options);
  const res = await quietly(() => handler({ requestContext: as(USER), ...event }));
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const historyEvent = (overrides = {}) => ({
  httpMethod: "GET",
  resource: HISTORY_ROUTE,
  pathParameters: { user_id: USER, chat_session_id: SESSION },
  queryStringParameters: null,
  ...overrides,
});

// Rows for the history route keyed on the SQL text.
function historySql({ userExists = true, owner = USER, messages = [] } = {}) {
  return fakeSql((text) => {
    if (text.startsWith("SELECT id FROM users")) return userExists ? [{ id: USER }] : [];
    if (text.includes("FROM chat_sessions")) return owner ? [{ id: SESSION, user_id: owner }] : [];
    if (text.includes("FROM chat_messages")) return messages;
    return [];
  });
}

test("chat history rejects non-UUID ids before querying", async () => {
  const sql = historySql();
  const res = await invoke(sql, historyEvent({ pathParameters: { user_id: "nope", chat_session_id: SESSION } }));
  assert.equal(res.statusCode, 400);
  assert.equal(sql.queries().length, 0);

  const res2 = await invoke(sql, historyEvent({ pathParameters: { user_id: USER, chat_session_id: "1; DROP" } }));
  assert.equal(res2.statusCode, 400);
});

test("chat history returns 404 for unknown user or session", async () => {
  assert.equal((await invoke(historySql({ userExists: false }), historyEvent())).statusCode, 404);
  assert.equal((await invoke(historySql({ owner: null }), historyEvent())).statusCode, 404);
});

test("chat history refuses sessions owned by another user without reading messages", async () => {
  const sql = historySql({ owner: OTHER_USER });
  const res = await invoke(sql, historyEvent());
  assert.equal(res.statusCode, 403);
  assert.ok(!sql.queries().some((q) => q.text.includes("FROM chat_messages")));
});

test("chat history returns the owner's messages with pagination", async () => {
  const messages = [
    { id: "m1", chat_session_id: SESSION, sender: "user", content: "hi", sources: null, warning: null, created_at: "2026-01-01", total_count: "3" },
    { id: "m2", chat_session_id: SESSION, sender: "AI", content: "hello", sources: [], warning: null, created_at: "2026-01-02", total_count: "3" },
  ];
  const sql = historySql({ messages });
  const res = await invoke(sql, historyEvent({ queryStringParameters: { limit: "2", offset: "0" } }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.chat_session_id, SESSION);
  assert.equal(res.body.messages.length, 2);
  assert.ok(res.body.messages.every((m) => !("total_count" in m)));
  assert.deepEqual(res.body.pagination, { limit: 2, offset: 0, total: 3, hasMore: true });
});

test("chat history caps the page size at 1000", async () => {
  const sql = historySql();
  const res = await invoke(sql, historyEvent({ queryStringParameters: { limit: "50000" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pagination.limit, 1000);
  const query = sql.queries().find((q) => q.text.includes("FROM chat_messages"));
  assert.ok(query.values.includes(1000));
});

test("PUT /user validates and normalizes email", async () => {
  const sql = fakeSql((text, values) => {
    if (text.startsWith("SELECT id FROM users")) return [{ id: USER }];
    if (text.startsWith("UPDATE users")) return [{ id: USER, email: values[0] }];
    return [];
  });
  const put = (body) =>
    invoke(sql, { httpMethod: "PUT", resource: "/user/{user_id}", pathParameters: { user_id: USER }, body });

  assert.equal((await put("{not json")).statusCode, 400);
  assert.equal((await put(JSON.stringify({ email: 42 }))).statusCode, 400);
  assert.equal((await put(JSON.stringify({ email: "not-an-email" }))).statusCode, 400);

  const ok = await put(JSON.stringify({ email: "  Parent@Example.COM " }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.email, "parent@example.com");

  // Only guest rows can be updated.
  const select = sql.queries().find((q) => q.text.startsWith("SELECT id FROM users"));
  const update = sql.queries().find((q) => q.text.startsWith("UPDATE users"));
  assert.ok(select.text.includes("identity_source = 'guest'"));
  assert.ok(update.text.includes("identity_source = 'guest'"));
});

const putEmail = (sql, email, options) =>
  invoke(
    sql,
    { httpMethod: "PUT", resource: "/user/{user_id}", pathParameters: { user_id: USER }, body: JSON.stringify({ email }) },
    options
  );

const guestSql = () =>
  fakeSql((text, values) => {
    if (text.startsWith("SELECT id FROM users")) return [{ id: USER }];
    if (text.startsWith("UPDATE users")) return [{ id: USER, email: values[0] }];
    return [];
  });

test("PUT /user refuses staff sign-up domains and their subdomains without writing", async () => {
  for (const email of ["admin@staff.example", "Admin@STAFF.example", "x@hr.staff.example", "y@board.example"]) {
    const sql = guestSql();
    const res = await putEmail(sql, email);
    assert.equal(res.statusCode, 400, email);
    assert.deepEqual(res.body, { error: "This email address cannot be used" });
    assert.equal(sql.queries().length, 0, email);
  }
  // A look-alike domain is not a subdomain.
  assert.equal((await putEmail(guestSql(), "p@notstaff.example")).statusCode, 200);
});

test("PUT /user fails closed when the staff domain list cannot be read", async () => {
  for (const options of [{ ssmParameters: { [STAFF_DOMAINS_PARAM]: new Error("ssm down") } }, { ssmParameters: { [STAFF_DOMAINS_PARAM]: " , " } }]) {
    const sql = guestSql();
    const res = await putEmail(sql, "parent@example.com", options);
    assert.equal(res.statusCode, 500);
    assert.ok(!sql.queries().some((q) => q.text.startsWith("UPDATE users")));
  }
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  try {
    const sql = guestSql();
    assert.equal((await putEmail(sql, "parent@example.com")).statusCode, 500);
    assert.ok(!sql.queries().some((q) => q.text.startsWith("UPDATE users")));
  } finally {
    process.env.ALLOWED_EMAIL_DOMAINS = STAFF_DOMAINS_PARAM;
  }
});

test("PUT /user on a non-guest row is 404 and nothing is updated", async () => {
  const sql = fakeSql(() => []);
  const res = await putEmail(sql, "parent@example.com");
  assert.equal(res.statusCode, 404);
  assert.ok(!sql.queries().some((q) => q.text.startsWith("UPDATE users")));
});

test("POST /user never binds a caller-supplied email and creates a guest row", async () => {
  const sql = fakeSql((text, values) =>
    text.startsWith("INSERT INTO users") ? [{ id: values[0], role: "student", credential_version: 0 }] : [],
  );
  const res = await invoke(sql, {
    httpMethod: "POST",
    resource: "/user",
    requestContext: as(""),
    body: JSON.stringify({ email: "admin@staff.example", display_name: "Guest" }),
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!("email" in res.body) || res.body.email == null);
  const insert = sql.queries().find((q) => q.text.startsWith("INSERT INTO users"));
  assert.ok(insert.text.includes("'guest'"));
  assert.ok(!/\bemail\b/.test(insert.text.split("RETURNING")[0]), "email is not inserted");
  for (const q of sql.queries()) {
    assert.ok(!JSON.stringify(q.values).includes("admin@staff.example"));
  }
});

test("PUT /user maps a unique violation to 409", async () => {
  const sql = fakeSql((text) => {
    if (text.startsWith("SELECT id FROM users")) return [{ id: USER }];
    if (text.startsWith("UPDATE users")) throw Object.assign(new Error("duplicate"), { code: "23505" });
    return [];
  });
  const res = await invoke(sql, {
    httpMethod: "PUT",
    resource: "/user/{user_id}",
    pathParameters: { user_id: USER },
    body: JSON.stringify({ email: "taken@example.com" }),
  });
  assert.equal(res.statusCode, 409);
});

test("user routes require the token's own user", async () => {
  const routes = [
    { httpMethod: "GET", resource: "/user/{user_id}", pathParameters: { user_id: USER } },
    { httpMethod: "PUT", resource: "/user/{user_id}", pathParameters: { user_id: USER }, body: JSON.stringify({ email: "a@example.com" }) },
    historyEvent(),
  ];
  for (const route of routes) {
    for (const requestContext of [undefined, as(""), as("user")]) {
      const sql = historySql();
      const res = await invoke(sql, { ...route, requestContext });
      assert.equal(res.statusCode, 401, `${route.httpMethod} ${route.resource}`);
      assert.equal(sql.queries().length, 0);
    }
    const sql = historySql();
    const res = await invoke(sql, { ...route, requestContext: as(OTHER_USER) });
    assert.equal(res.statusCode, 403, `${route.httpMethod} ${route.resource}`);
    assert.equal(sql.queries().length, 0);
  }
});

test("POST /user fails closed when the credential version column is missing", async () => {
  const sql = fakeSql((text, values) =>
    text.startsWith("INSERT INTO users") ? [{ id: values[0], role: "student" }] : [],
  );
  const res = await invoke(sql, { httpMethod: "POST", resource: "/user", requestContext: as(""), body: "{}" });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.credential, undefined);
});

test("POST /user works with an anonymous token and returns a credential for the new user", async () => {
  const sql = fakeSql((text, values) =>
    text.startsWith("INSERT INTO users") ? [{ id: values[0], role: "student", credential_version: 0 }] : [],
  );
  const res = await invoke(sql, {
    httpMethod: "POST",
    resource: "/user",
    requestContext: as(""),
    body: JSON.stringify({ role: "admin", display_name: "Anonymous" }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.role, "student");
  const signed = JSON.parse(res.body.credential.replace(/^signed:/, ""));
  const { iat, ...claims } = signed.payload;
  assert.deepEqual(claims, {
    typ: "credential", sub: res.body.userId, ver: 0, iss: "test-issuer", aud: "kc-token-exchange",
  });
  assert.ok(Number.isInteger(iat));
  assert.equal(signed.secret, "test-jwt-secret");
  assert.equal(signed.options.algorithm, "HS256");
  assert.equal(signed.options.expiresIn, "30d");
});

test("responses are not logged", async () => {
  const sql = fakeSql((text, values) =>
    text.startsWith("INSERT INTO users") ? [{ id: values[0], role: "student", credential_version: 0 }] : [],
  );
  const { handler } = loadHandler("userHandler", sql);
  const logged = [];
  const saved = console.log;
  console.log = (...args) => logged.push(JSON.stringify(args));
  try {
    await handler({ httpMethod: "POST", resource: "/user", requestContext: as(""), body: "{}" });
  } finally {
    console.log = saved;
  }
  assert.ok(!logged.some((line) => line.includes("signed:")), "credential must not be logged");
});

test("removed and unknown routes fail without leaking details", async () => {
  for (const resource of ["/user/exampleEndpoint", "/user/nope"]) {
    const res = await invoke(fakeSql(), { httpMethod: "GET", resource });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "Internal server error" });
  }
});
