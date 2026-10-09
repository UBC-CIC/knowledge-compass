/**
 * Unit tests for handlers/chatSessionHandler.js: the acting user comes only
 * from the verified token (requestContext.authorizer.userId), and session
 * ownership is checked against it on every route. Fake SQL client, no database:
 *
 *   node --test cdk/lambda/handlers/tests/chatSessionHandler.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler, quietly } = require("./_loadHandler.js");

const USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const OTHER_USER = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c";
const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";

// What the user authorizer sets for a token bound to `userId` ("" = anonymous).
const as = (userId) => ({ authorizer: { userId, role: "user", jti: "j" } });

async function invoke(sql, event) {
  const { handler } = loadHandler("chatSessionHandler", sql);
  const res = await quietly(() => handler({ requestContext: as(USER), ...event }));
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

// Session lookups return a session owned by `owner` (or nothing when null).
function sessionSql(owner = USER, extra = () => []) {
  return fakeSql((text, values) => {
    if (text.startsWith("SELECT id, user_id FROM chat_sessions")) {
      return owner ? [{ id: SESSION, user_id: owner }] : [];
    }
    return extra(text, values);
  });
}

const mutations = (sql) => sql.queries().filter((q) => /^(UPDATE|DELETE|INSERT)/.test(q.text));

const ROUTES = [
  { httpMethod: "GET", resource: "/chat_sessions/user/{user_id}", pathParameters: { user_id: USER } },
  { httpMethod: "POST", resource: "/chat_sessions", body: JSON.stringify({ user_sessions_session_id: USER }) },
  { httpMethod: "PUT", resource: "/chat_sessions/{chat_session_id}", pathParameters: { chat_session_id: SESSION }, body: JSON.stringify({ title: "New" }) },
  { httpMethod: "DELETE", resource: "/chat_sessions/{chat_session_id}", pathParameters: { chat_session_id: SESSION } },
  { httpMethod: "GET", resource: "/chat_sessions/{chat_session_id}/feedback", pathParameters: { chat_session_id: SESSION } },
  { httpMethod: "PUT", resource: "/chat_sessions/{chat_session_id}/feedback", pathParameters: { chat_session_id: SESSION }, body: JSON.stringify({ rating: "up" }) },
];

test("every route rejects anonymous tokens before touching the database", async () => {
  for (const route of ROUTES) {
    for (const requestContext of [undefined, {}, as(""), as("user"), as("not-a-uuid")]) {
      const sql = sessionSql();
      const res = await invoke(sql, { ...route, requestContext });
      assert.equal(res.statusCode, 401, `${route.httpMethod} ${route.resource}`);
      assert.equal(sql.queries().length, 0);
    }
  }
});

test("every route rejects a client user_id that differs from the token's user", async () => {
  for (const route of ROUTES) {
    const sql = sessionSql(OTHER_USER);
    const event = { ...route, queryStringParameters: { user_id: OTHER_USER } };
    if (route.resource === "/chat_sessions/user/{user_id}") event.pathParameters = { user_id: OTHER_USER };
    if (route.httpMethod === "POST") event.body = JSON.stringify({ user_sessions_session_id: OTHER_USER });
    const res = await invoke(sql, event);
    assert.equal(res.statusCode, 403, `${route.httpMethod} ${route.resource}`);
    assert.equal(mutations(sql).length, 0);
  }
});

test("the token's user is acted on even when the client omits user_id", async () => {
  const sql = fakeSql((text) => {
    if (text.startsWith("SELECT id FROM users")) return [{ id: USER }];
    if (text.startsWith("INSERT INTO chat_sessions")) return [{ id: SESSION, user_id: USER }];
    return [];
  });
  const created = await invoke(sql, { httpMethod: "POST", resource: "/chat_sessions", body: "{}" });
  assert.equal(created.statusCode, 201);
  const insert = sql.queries().find((q) => q.text.startsWith("INSERT INTO chat_sessions"));
  assert.equal(insert.values[1], USER);

  const listSql = fakeSql(() => []);
  await invoke(listSql, { httpMethod: "GET", resource: "/chat_sessions/user/{user_id}", pathParameters: {} });
  assert.deepEqual(listSql.queries()[0].values, [USER]);
});

test("rename requires chat_session_id and a title", async () => {
  const base = { httpMethod: "PUT", resource: "/chat_sessions/{chat_session_id}" };
  const sql = sessionSql();
  assert.equal((await invoke(sql, { ...base, pathParameters: {} })).statusCode, 400);
  assert.equal(
    (await invoke(sql, {
      ...base,
      pathParameters: { chat_session_id: SESSION },
      body: JSON.stringify({ title: "   " }),
    })).statusCode,
    400,
  );
  assert.equal(mutations(sql).length, 0);
});

test("rename and delete refuse another user's session", async () => {
  for (const [httpMethod, body] of [["PUT", JSON.stringify({ title: "New" })], ["DELETE", undefined]]) {
    const sql = sessionSql(OTHER_USER);
    const res = await invoke(sql, {
      httpMethod,
      resource: "/chat_sessions/{chat_session_id}",
      pathParameters: { chat_session_id: SESSION },
      queryStringParameters: { user_id: USER },
      body,
    });
    assert.equal(res.statusCode, 403, httpMethod);
    assert.equal(mutations(sql).length, 0, `${httpMethod} must not modify data`);
  }
});

test("rename and delete return 404 for a missing session", async () => {
  for (const httpMethod of ["PUT", "DELETE"]) {
    const res = await invoke(sessionSql(null), {
      httpMethod,
      resource: "/chat_sessions/{chat_session_id}",
      pathParameters: { chat_session_id: SESSION },
      body: JSON.stringify({ title: "New" }),
    });
    assert.equal(res.statusCode, 404, httpMethod);
  }
});

test("owner can delete; messages are removed before the session", async () => {
  const sql = sessionSql(USER);
  const res = await invoke(sql, {
    httpMethod: "DELETE",
    resource: "/chat_sessions/{chat_session_id}",
    pathParameters: { chat_session_id: SESSION },
    queryStringParameters: { user_id: USER },
  });
  assert.equal(res.statusCode, 204);
  const deletes = mutations(sql).map((q) => q.text);
  assert.equal(deletes.length, 2);
  assert.match(deletes[0], /DELETE FROM chat_messages/);
  assert.match(deletes[1], /DELETE FROM chat_sessions/);
});

test("owner can rename; the title is trimmed", async () => {
  const sql = sessionSql(USER, (text, values) =>
    text.startsWith("UPDATE chat_sessions") ? [{ id: SESSION, user_id: USER, title: values[0] }] : [],
  );
  const res = await invoke(sql, {
    httpMethod: "PUT",
    resource: "/chat_sessions/{chat_session_id}",
    pathParameters: { chat_session_id: SESSION },
    queryStringParameters: { user_id: USER },
    body: JSON.stringify({ title: "  Grade 9 transition  " }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.title, "Grade 9 transition");
});

test("feedback validates the session id and ownership", async () => {
  const get = (sql, sessionId = SESSION) =>
    invoke(sql, {
      httpMethod: "GET",
      resource: "/chat_sessions/{chat_session_id}/feedback",
      pathParameters: { chat_session_id: sessionId },
      queryStringParameters: { user_id: USER },
    });

  assert.equal((await get(sessionSql(), "bad-id")).statusCode, 400);
  assert.equal((await get(sessionSql(null))).statusCode, 404);
  assert.equal((await get(sessionSql(OTHER_USER))).statusCode, 403);
  assert.equal((await get(sessionSql(USER))).statusCode, 200);
});

test("another user's feedback cannot be read or overwritten", async () => {
  // The finding's scenario: a valid token for USER naming a session of OTHER_USER.
  for (const [httpMethod, body] of [["GET", undefined], ["PUT", JSON.stringify({ rating: "down", comment: "x" })]]) {
    const sql = sessionSql(OTHER_USER);
    const res = await invoke(sql, {
      httpMethod,
      resource: "/chat_sessions/{chat_session_id}/feedback",
      pathParameters: { chat_session_id: SESSION },
      body,
    });
    assert.equal(res.statusCode, 403, httpMethod);
    assert.ok(!sql.queries().some((q) => q.text.includes("session_feedback")));
  }
});

test("removed chat_history route is no longer served here", async () => {
  const res = await invoke(fakeSql(), {
    httpMethod: "GET",
    resource: "/chat_sessions/{chat_session_id}/chat_history",
    pathParameters: { chat_session_id: SESSION },
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Internal server error" });
});
