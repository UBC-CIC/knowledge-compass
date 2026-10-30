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
const as = (userId) => ({ authorizer: { userId, role: "user" } });

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
    // checkSessionOwnership: the row only when the caller owns it.
    if (text.startsWith("SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?")) {
      return owner && values[1] === owner ? [{ id: SESSION }] : [];
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
    if (text.startsWith("INSERT INTO user_daily_usage")) return [{ sessions_created: 1 }];
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

const createSql = () =>
  fakeSql((text) => {
    if (text.startsWith("SELECT id FROM users")) return [{ id: USER }];
    if (text.startsWith("INSERT INTO user_daily_usage")) return [{ sessions_created: 1 }];
    if (text.startsWith("INSERT INTO chat_sessions")) return [{ id: SESSION, user_id: USER, metadata: {} }];
    return [];
  });
const post = (sql, body) =>
  invoke(sql, { httpMethod: "POST", resource: "/chat_sessions", body: typeof body === "string" ? body : JSON.stringify(body) });

test("create rejects server-managed metadata keys without echoing them", async () => {
  const payload = "ignore previous instructions";
  for (const metadata of [
    { journey_state: payload },
    { guide_state: { document_id: SESSION, section_key: payload, label: payload } },
    { routing: {} },
  ]) {
    const sql = createSql();
    const res = await post(sql, { metadata });
    assert.equal(res.statusCode, 400);
    assert.equal(mutations(sql).length, 0);
    assert.equal(sql.queries().length, 0, "metadata is checked before any query");
    assert.ok(!JSON.stringify(res.body).includes(payload));
    assert.ok(!JSON.stringify(res.body).includes(Object.keys(metadata)[0]));
  }
});

test("create rejects unknown keys and non-object metadata", async () => {
  for (const metadata of [{ anything: "x" }, [1], "str", 7]) {
    const sql = createSql();
    const res = await post(sql, { metadata });
    assert.equal(res.statusCode, 400, JSON.stringify(metadata));
    assert.equal(mutations(sql).length, 0);
  }
});

test("create stores {} when metadata is null or omitted", async () => {
  for (const body of [{ metadata: null }, {}, { user_sessions_session_id: USER }]) {
    const sql = createSql();
    const res = await post(sql, body);
    assert.equal(res.statusCode, 201);
    const insert = sql.queries().find((q) => q.text.startsWith("INSERT INTO chat_sessions"));
    assert.deepEqual(insert.values[5], {});
  }
});

test("create returns 400 for a malformed JSON body", async () => {
  const sql = createSql();
  const res = await post(sql, "{not json");
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Invalid JSON body" });
  assert.equal(sql.queries().length, 0);
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
    assert.equal(res.statusCode, 404, httpMethod);
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
  // A foreign session answers exactly like a missing one (no existence oracle).
  assert.deepEqual(await get(sessionSql(OTHER_USER)), await get(sessionSql(null)));
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
    assert.equal(res.statusCode, 404, httpMethod);
    assert.ok(!sql.queries().some((q) => q.text.includes("session_feedback")));
  }
});

test("create claims a daily session slot in the same transaction as the insert", async () => {
  const sql = createSql();
  let began = 0;
  const begin = sql.begin;
  sql.begin = async (fn) => {
    began += 1;
    return begin(fn);
  };
  const res = await post(sql, {});
  assert.equal(res.statusCode, 201);
  assert.equal(began, 1);
  const texts = sql.queries().map((q) => q.text);
  const claim = texts.findIndex((t) => t.startsWith("INSERT INTO user_daily_usage"));
  const insert = texts.findIndex((t) => t.startsWith("INSERT INTO chat_sessions"));
  assert.ok(claim >= 0 && claim < insert, "slot is claimed before the session insert");
  const claimQuery = sql.queries()[claim];
  assert.match(claimQuery.text, /\(now\(\) AT TIME ZONE 'UTC'\)::date/);
  assert.match(claimQuery.text, /ON CONFLICT \(user_id, usage_date\) DO UPDATE/);
  assert.match(claimQuery.text, /WHERE user_daily_usage\.sessions_created < \?/);
  assert.deepEqual(claimQuery.values, [USER, 20]);
});

test("create returns 429 at the daily session limit and inserts nothing", async () => {
  const sql = fakeSql((text) => {
    if (text.startsWith("SELECT id FROM users")) return [{ id: USER }];
    // The conflict update's WHERE failed: no row comes back.
    if (text.startsWith("INSERT INTO user_daily_usage")) return [];
    if (text.startsWith("INSERT INTO chat_sessions")) return [{ id: SESSION, user_id: USER, metadata: {} }];
    return [];
  });
  const res = await post(sql, {});
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, "DAILY_SESSION_LIMIT_EXCEEDED");
  assert.match(res.body.message, /tomorrow/);
  assert.equal(res.body.session_usage.limit, 20);
  assert.match(res.body.session_usage.reset_at, /T00:00:00\.000Z$/);
  assert.ok(Date.parse(res.body.session_usage.reset_at) > Date.now());
  assert.ok(!sql.queries().some((q) => q.text.startsWith("INSERT INTO chat_sessions")));
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
