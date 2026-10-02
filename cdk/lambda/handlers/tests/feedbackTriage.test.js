/**
 * Unit tests for handlers/utils/feedbackTriage.js (validation, star/dismiss
 * updates and analytics feedback lists) with a fake SQL client. No database:
 *
 *   node --test cdk/lambda/handlers/tests/feedbackTriage.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const ft = require("../utils/feedbackTriage.js");

const UUID = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const ROUTE = "PUT /admin/feedback/{chat_session_id}";

// Minimal stand-in for the postgres.js tagged-template client.
function fakeSql(handler = () => []) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return Promise.resolve(handler(text, values));
  };
  sql.calls = calls;
  return sql;
}

// Emulates the UPDATE: applies the star/dismiss actions to an existing row.
function triageSql(row) {
  return fakeSql((text, values) => {
    if (!row) return [];
    const [star, dismiss] = values;
    const apply = (action, current) =>
      action === "set" ? current ?? "now" : action === "clear" ? null : current;
    row.starred_at = apply(star, row.starred_at);
    row.dismissed_at = apply(dismiss, row.dismissed_at);
    return [{ chat_session_id: UUID, starred: row.starred_at !== null, dismissed: row.dismissed_at !== null }];
  });
}

const triageEvent = (body, id = UUID) => ({
  pathParameters: { chat_session_id: id },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

async function call(sql, event, routeKey = ROUTE) {
  const response = { statusCode: 200, body: "" };
  const handled = await ft.handleFeedbackTriageRequest(sql, event, routeKey, response);
  return { handled, statusCode: response.statusCode, body: JSON.parse(response.body || "null") };
}

test("validateTriageBody accepts booleans and rejects bad input", () => {
  assert.deepEqual(ft.validateTriageBody({ starred: true }), { starred: true });
  assert.deepEqual(ft.validateTriageBody({ dismissed: false }), { dismissed: false });
  assert.deepEqual(ft.validateTriageBody({ starred: false, dismissed: true }), { starred: false, dismissed: true });
  assert.throws(() => ft.validateTriageBody({}), /starred and\/or dismissed/);
  assert.throws(() => ft.validateTriageBody({ starred: "yes" }), /boolean/);
  assert.throws(() => ft.validateTriageBody({ starred: true, comment: "x" }), /Unknown field/);
  assert.throws(() => ft.validateTriageBody([]), /JSON object/);
  assert.throws(() => ft.validateTriageBody(null), /JSON object/);
});

test("triageActions: dismissing always clears the star", () => {
  assert.deepEqual(ft.triageActions({ starred: true }), { star: "set", dismiss: "keep" });
  assert.deepEqual(ft.triageActions({ starred: false }), { star: "clear", dismiss: "keep" });
  assert.deepEqual(ft.triageActions({ dismissed: true }), { star: "clear", dismiss: "set" });
  assert.deepEqual(ft.triageActions({ dismissed: false }), { star: "keep", dismiss: "clear" });
  assert.deepEqual(ft.triageActions({ starred: true, dismissed: true }), { star: "clear", dismiss: "set" });
});

test("star, unstar, dismiss and restore", async () => {
  const row = { starred_at: null, dismissed_at: null };
  const sql = triageSql(row);

  let res = await call(sql, triageEvent({ starred: true }));
  assert.equal(res.handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { chat_session_id: UUID, starred: true, dismissed: false });

  res = await call(sql, triageEvent({ starred: false }));
  assert.deepEqual(res.body, { chat_session_id: UUID, starred: false, dismissed: false });

  res = await call(sql, triageEvent({ dismissed: true }));
  assert.deepEqual(res.body, { chat_session_id: UUID, starred: false, dismissed: true });

  res = await call(sql, triageEvent({ dismissed: false }));
  assert.deepEqual(res.body, { chat_session_id: UUID, starred: false, dismissed: false });

  assert.match(sql.calls[0].text, /UPDATE session_feedback/);
  assert.equal(sql.calls[0].values[2], UUID);
});

test("dismissing a starred comment removes the star", async () => {
  const row = { starred_at: "earlier", dismissed_at: null };
  const res = await call(triageSql(row), triageEvent({ dismissed: true }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { chat_session_id: UUID, starred: false, dismissed: true });
});

test("response never includes comment text", async () => {
  const res = await call(triageSql({ starred_at: null, dismissed_at: null }), triageEvent({ starred: true }));
  assert.equal(Object.keys(res.body).includes("comment"), false);
});

test("invalid ids and bodies return 400 without touching the database", async () => {
  const sql = fakeSql();
  for (const event of [
    triageEvent({ starred: true }, "not-a-uuid"),
    triageEvent({ starred: true }, null),
    triageEvent({}),
    triageEvent(undefined),
    triageEvent({ starred: "true" }),
    triageEvent({ starred: true, extra: 1 }),
    triageEvent("{not json"),
  ]) {
    const res = await call(sql, event);
    assert.equal(res.handled, true);
    assert.equal(res.statusCode, 400, JSON.stringify(event));
    assert.ok(res.body.error);
  }
  assert.equal(sql.calls.length, 0);
});

test("missing feedback row returns 404", async () => {
  const res = await call(triageSql(null), triageEvent({ starred: true }));
  assert.equal(res.statusCode, 404);
});

test("database errors return a generic 500", async () => {
  const sql = () => Promise.reject(new Error("boom"));
  const original = console.error;
  console.error = () => {};
  try {
    const res = await call(sql, triageEvent({ starred: true }));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "Internal server error" });
  } finally {
    console.error = original;
  }
});

test("other routes are not handled", async () => {
  const sql = fakeSql();
  const res = await call(sql, triageEvent({ starred: true }), "GET /admin/analytics");
  assert.equal(res.handled, false);
  assert.equal(ft.isFeedbackTriageRoute("GET /admin/feedback/{chat_session_id}"), false);
  assert.equal(ft.isFeedbackTriageRoute(ROUTE), true);
  assert.equal(sql.calls.length, 0);
});

test("fetchFeedbackLists filters each list and returns three keys", async () => {
  const start = "2026-01-01T00:00:00.000Z";
  const end = "2026-02-01T00:00:00.000Z";
  const sql = fakeSql((text) => [{ text }]);
  const out = await ft.fetchFeedbackLists(sql, start, end);

  assert.deepEqual(Object.keys(out).sort(), ["dismissedFeedback", "recentFeedback", "starredFeedback"]);
  assert.equal(sql.calls.length, 3);

  const [recent, starred, dismissed] = sql.calls;
  assert.match(recent.text, /dismissed_at IS NULL/);
  assert.match(recent.text, /comment IS NOT NULL/);
  assert.match(recent.text, /starred_at IS NOT NULL\) AS starred/);
  assert.deepEqual(recent.values.slice(0, 2), [start, end]);

  assert.match(starred.text, /starred_at IS NOT NULL/);
  assert.match(starred.text, /dismissed_at IS NULL/);
  assert.doesNotMatch(starred.text, /updated_at >=/);
  assert.equal(starred.values.includes(start), false);

  assert.match(dismissed.text, /dismissed_at IS NOT NULL/);
  assert.deepEqual(dismissed.values.slice(0, 2), [start, end]);
});

// --- GET /admin/feedback/{chat_session_id}/message --------------------------

const MESSAGE_ROUTE = "GET /admin/feedback/{chat_session_id}/message";
const MSG_ID = "7a1e2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

test("rated message: returns only the linked AI reply", async () => {
  const sql = fakeSql(() => [
    { inferred: false, id: MSG_ID, content: "Here are some steps.", created_at: "2026-09-01T00:00:00Z" },
  ]);
  const res = await call(sql, { pathParameters: { chat_session_id: UUID } }, MESSAGE_ROUTE);
  assert.equal(res.handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    message: { id: MSG_ID, sender: "AI", content: "Here are some steps.", created_at: "2026-09-01T00:00:00Z" },
    inferred: false,
  });
  assert.equal(sql.calls.length, 1);
  assert.match(sql.calls[0].text, /cm\.sender = 'AI'/);
  assert.match(sql.calls[0].text, /cm\.id = sf\.chat_message_id/);
  assert.match(sql.calls[0].text, /LIMIT 1/);
  assert.deepEqual(sql.calls[0].values, [UUID]);
});

test("rated message: older feedback without a link is inferred", async () => {
  const sql = fakeSql(() => [{ inferred: true, id: MSG_ID, content: "Reply", created_at: "t" }]);
  const res = await call(sql, { pathParameters: { chat_session_id: UUID } }, MESSAGE_ROUTE);
  assert.equal(res.body.inferred, true);
  assert.equal(res.body.message.id, MSG_ID);
});

test("rated message: feedback with no AI reply returns message null", async () => {
  const sql = fakeSql(() => [{ inferred: true, id: null, content: null, created_at: null }]);
  const res = await call(sql, { pathParameters: { chat_session_id: UUID } }, MESSAGE_ROUTE);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { message: null, inferred: true });
});

test("rated message: no feedback returns 404, bad id returns 400", async () => {
  let res = await call(fakeSql(() => []), { pathParameters: { chat_session_id: UUID } }, MESSAGE_ROUTE);
  assert.equal(res.statusCode, 404);

  const sql = fakeSql();
  res = await call(sql, { pathParameters: { chat_session_id: "nope" } }, MESSAGE_ROUTE);
  assert.equal(res.statusCode, 400);
  assert.equal(sql.calls.length, 0);
});

test("rated message route is status-only logged", () => {
  assert.equal(ft.isFeedbackTriageRoute(MESSAGE_ROUTE), true);
});
