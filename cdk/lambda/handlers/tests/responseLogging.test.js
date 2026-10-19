/**
 * Regression tests: REST handlers log one status line per request and never
 * the response body (emails, transcripts, sources) or database error detail.
 * Fake SQL client, no database:
 *
 *   node --test cdk/lambda/handlers/tests/responseLogging.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler } = require("./_loadHandler.js");

const EMAIL = "sentinel@example.org";
const TRANSCRIPT = "SENTINEL-TRANSCRIPT";
const USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";
const REQUEST_ID = "req-1";

const userContext = { requestId: REQUEST_ID, authorizer: { userId: USER, role: "user" } };
const ADMIN_SUB = "11111111-2222-3333-4444-555555555555";
const adminContext = {
  requestId: REQUEST_ID,
  authorizer: { role: "admin", email: "admin@example.com", userId: ADMIN_SUB },
};

// Invoke with console.log/error/warn captured as JSON-ish strings and raw args.
async function capture(name, sql, event) {
  const { handler } = loadHandler(name, sql);
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const lines = [];
  console.log = console.error = console.warn = (...args) => lines.push(args);
  try {
    const response = await handler(event);
    return { response, lines };
  } finally {
    Object.assign(console, saved);
  }
}

const text = (args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

// adminHandler status lines also carry the acting admin's Cognito sub (actorSub).
function assertStatusOnly({ response, lines }, { resource, statusCode = 200, sentinel, actorSub }) {
  const expected = { statusCode, resource, requestId: REQUEST_ID };
  if (actorSub !== undefined) expected.actorSub = actorSub;
  assert.equal(response.statusCode, statusCode);
  if (sentinel) assert.ok(response.body.includes(sentinel), "response carries the sentinel");
  for (const args of lines) {
    for (const value of [EMAIL, TRANSCRIPT]) {
      assert.ok(!text(args).includes(value), `log line leaks ${value}: ${text(args)}`);
    }
  }
  assert.ok(
    lines.some(
      (args) =>
        args.length === 1 &&
        JSON.stringify(args[0]) === JSON.stringify(expected)
    ),
    `expected a status line for ${resource}`
  );
}

test("userHandler GET /user/{user_id} logs status only", async () => {
  const sql = fakeSql((q) => (q.includes("FROM users") ? [{ id: USER, email: EMAIL, role: "user" }] : []));
  const result = await capture("userHandler", sql, {
    httpMethod: "GET",
    resource: "/user/{user_id}",
    pathParameters: { user_id: USER },
    requestContext: userContext,
  });
  assertStatusOnly(result, { resource: "/user/{user_id}", sentinel: EMAIL });
});

test("userHandler chat history logs status only", async () => {
  const resource = "/user/{user_id}/chat_sessions/{chat_session_id}/chat_history";
  const sql = fakeSql((q) => {
    if (q.startsWith("SELECT id FROM users")) return [{ id: USER }];
    if (q.includes("FROM chat_sessions")) return [{ id: SESSION, user_id: USER }];
    if (q.includes("FROM chat_messages")) {
      return [{ id: "m1", chat_session_id: SESSION, sender: "user", content: TRANSCRIPT, sources: null, total_count: "1" }];
    }
    return [];
  });
  const result = await capture("userHandler", sql, {
    httpMethod: "GET",
    resource,
    pathParameters: { user_id: USER, chat_session_id: SESSION },
    queryStringParameters: null,
    requestContext: userContext,
  });
  assertStatusOnly(result, { resource, sentinel: TRANSCRIPT });
});

test("chatSessionHandler GET /chat_sessions/user/{user_id} logs status only", async () => {
  const sql = fakeSql((q) =>
    q.includes("FROM chat_sessions") ? [{ id: SESSION, user_id: USER, title: TRANSCRIPT, metadata: {} }] : []
  );
  const result = await capture("chatSessionHandler", sql, {
    httpMethod: "GET",
    resource: "/chat_sessions/user/{user_id}",
    pathParameters: { user_id: USER },
    requestContext: userContext,
  });
  assertStatusOnly(result, { resource: "/chat_sessions/user/{user_id}", sentinel: TRANSCRIPT });
});

test("systemMessagesHandler GET /system_message/{message_type} logs status only", async () => {
  const sql = fakeSql((q) =>
    q.includes("FROM system_messages") ? [{ id: "s1", type: "welcome_message", content: TRANSCRIPT, version: 1 }] : []
  );
  const result = await capture("systemMessagesHandler", sql, {
    httpMethod: "GET",
    resource: "/system_message/{message_type}",
    pathParameters: { message_type: "welcome_message" },
    requestContext: userContext,
  });
  assertStatusOnly(result, { resource: "/system_message/{message_type}", sentinel: TRANSCRIPT });
});

test("adminHandler GET /admin/users logs status only", async () => {
  const sql = fakeSql((q) => (q.includes("FROM users") ? [{ id: USER, email: EMAIL, role: "user" }] : []));
  const result = await capture("adminHandler", sql, {
    httpMethod: "GET",
    resource: "/admin/users",
    requestContext: adminContext,
  });
  assertStatusOnly(result, { resource: "/admin/users", sentinel: EMAIL, actorSub: ADMIN_SUB });
});

test("adminHandler GET /admin/chat_sessions/{sessionId}/messages logs status only", async () => {
  const resource = "/admin/chat_sessions/{sessionId}/messages";
  const sql = fakeSql((q) => {
    if (q.includes("FROM chat_messages")) {
      return [{ id: "m1", chat_session_id: SESSION, sender: "AI", content: TRANSCRIPT, sources: [{ url: EMAIL }] }];
    }
    if (q.includes("FROM users")) return [{ id: "a1", role: "admin" }];
    return [];
  });
  const result = await capture("adminHandler", sql, {
    httpMethod: "GET",
    resource,
    pathParameters: { sessionId: SESSION },
    requestContext: adminContext,
  });
  assertStatusOnly(result, { resource, sentinel: TRANSCRIPT, actorSub: ADMIN_SUB });
});

test("adminHandler database errors log a summary without detail", async () => {
  const sql = fakeSql((q) => {
    if (q.includes("FROM users") && q.includes("ORDER BY")) {
      const error = new Error(`duplicate key value for ${EMAIL}`);
      error.name = "PostgresError";
      error.code = "23505";
      error.severity = "ERROR";
      error.detail = `Key (email)=(${EMAIL}) already exists.`;
      throw error;
    }
    if (q.includes("FROM users")) return [{ id: "a1", role: "admin" }];
    return [];
  });
  const result = await capture("adminHandler", sql, {
    httpMethod: "GET",
    resource: "/admin/users",
    requestContext: adminContext,
  });
  assertStatusOnly(result, { resource: "/admin/users", statusCode: 500, actorSub: ADMIN_SUB });
  assert.ok(
    result.lines.some((args) => text(args).includes('"name":"PostgresError"') && text(args).includes('"code":"23505"')),
    "error summary is logged"
  );
});
