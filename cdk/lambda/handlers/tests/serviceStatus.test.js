/**
 * Service status (maintenance banner / read-only): the admin settings API and the public
 * read used by the chat UI. Fake SQL client, no database:
 *
 *   node --test cdk/lambda/handlers/tests/serviceStatus.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler, quietly, TEST_ALLOWED_ORIGIN } = require("./_loadHandler.js");

async function invoke(handlerName, sql, event) {
  const { handler } = loadHandler(handlerName, sql);
  const res = await quietly(() => handler(event));
  return { statusCode: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null };
}

const adminContext = {
  authorizer: { role: "admin", email: "admin@example.com", userId: "11111111-2222-3333-4444-555555555555" },
};

// ── PUT / GET /admin/system-settings ─────────────────────────────────────────

function settingsSql({ stored = { service_status: "normal", service_message: null } } = {}) {
  return fakeSql(
    (text) => {
      if (text.includes("FROM users")) return [{ id: "u1", role: "admin" }];
      if (text.startsWith("SELECT service_status, service_message")) return [stored];
      if (text.includes("UPDATE system_settings")) return [{ id: "s1", ...stored }];
      if (text.includes("WITH latest AS") && text.includes("LEFT JOIN users")) return [{ id: "s1", ...stored }];
      return [];
    },
    { rejectUndefined: true }
  );
}

// `...context` so an explicit `undefined` request context is not replaced by the admin one.
const put = (sql, patch, ...context) =>
  invoke("adminHandler", sql, {
    httpMethod: "PUT",
    resource: "/admin/system-settings",
    requestContext: context.length ? context[0] : adminContext,
    body: JSON.stringify(patch),
  });

const updateQuery = (sql) => sql.queries().find((q) => q.text.includes("UPDATE system_settings"));

test("PUT accepts each valid status together with a message", async () => {
  for (const service_status of ["normal", "banner", "read_only"]) {
    const sql = settingsSql();
    const res = await put(sql, { service_status, service_message: "Back at 3 pm." });
    assert.equal(res.statusCode, 200, `${service_status}: ${JSON.stringify(res.body)}`);
    const update = updateQuery(sql);
    assert.ok(update.values.includes(service_status));
    assert.ok(update.values.includes("Back at 3 pm."));
    assert.ok(!update.values.includes(undefined));
  }
});

test("PUT rejects an unknown status or a non-text message", async () => {
  for (const patch of [
    { service_status: "maintenance", service_message: "x" },
    { service_status: "" },
    { service_status: 1 },
    { service_message: 5 },
    { service_message: { text: "x" } },
  ]) {
    const sql = settingsSql();
    const res = await put(sql, patch);
    assert.equal(res.statusCode, 400, JSON.stringify(patch));
    assert.equal(updateQuery(sql), undefined, "nothing is written for a rejected patch");
  }
});

test("PUT refuses banner or read_only without a message", async () => {
  for (const service_status of ["banner", "read_only"]) {
    for (const patch of [
      { service_status },
      { service_status, service_message: "" },
      { service_status, service_message: "   " },
      { service_status, service_message: null },
      { service_status, service_message: "\n\t " },
    ]) {
      const sql = settingsSql();
      const res = await put(sql, patch);
      assert.equal(res.statusCode, 400, JSON.stringify(patch));
      assert.match(res.body.error, /service_message is required/);
      assert.equal(updateQuery(sql), undefined);
    }
  }
});

test("PUT lets the status change alone when a message is already stored", async () => {
  const sql = settingsSql({ stored: { service_status: "normal", service_message: "Planned work tonight." } });
  const res = await put(sql, { service_status: "banner" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const update = updateQuery(sql);
  assert.ok(update.values.includes("banner"));
  // The message was not part of the patch, so the "message provided" flag is false.
  assert.ok(update.values.includes(false));
});

test("PUT refuses to clear the message while the stored status still needs one", async () => {
  const sql = settingsSql({ stored: { service_status: "banner", service_message: "Planned work." } });
  const res = await put(sql, { service_message: null });
  assert.equal(res.statusCode, 400);
  assert.equal(updateQuery(sql), undefined);
});

test("PUT clears the message explicitly with null or empty text, and leaves it alone when omitted", async () => {
  const stored = { service_status: "normal", service_message: "Old note" };

  for (const clear of [null, "", "   "]) {
    const sql = settingsSql({ stored });
    const res = await put(sql, { service_status: "normal", service_message: clear });
    assert.equal(res.statusCode, 200, JSON.stringify(clear));
    const update = updateQuery(sql);
    assert.match(update.text, /CASE WHEN \?::boolean THEN \?::text ELSE s\.service_message END/);
    const flagIndex = update.values.indexOf(true);
    assert.ok(flagIndex >= 0, "message-provided flag is true");
    assert.equal(update.values[flagIndex + 1], null, "the message binds null, which clears it");
  }

  // Untouched: another setting only. The flag is false and no service bindings are set.
  const sql = settingsSql({ stored });
  const res = await put(sql, { max_messages_per_day: 50 });
  assert.equal(res.statusCode, 200);
  const update = updateQuery(sql);
  assert.ok(update.values.includes(false), "message-provided flag is false");
  assert.ok(!update.values.includes("Old note"));
  assert.equal(sql.queries().filter((q) => q.text.startsWith("SELECT service_status")).length, 0, "no extra read when service fields are not patched");
});

test("PUT strips control characters, collapses whitespace and enforces 500 characters", async () => {
  const sql = settingsSql();
  const res = await put(sql, { service_status: "banner", service_message: "  Back\u0000 at\r\n3\tpm.\u0007  " });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(updateQuery(sql).values.includes("Back at 3 pm."));

  const exactly = await put(settingsSql(), { service_status: "banner", service_message: "a".repeat(500) });
  assert.equal(exactly.statusCode, 200);
  const tooLong = settingsSql();
  const rejected = await put(tooLong, { service_status: "banner", service_message: "a".repeat(501) });
  assert.equal(rejected.statusCode, 400);
  assert.equal(updateQuery(tooLong), undefined);
});

test("PUT stays admin-only: non-admin callers are rejected before any query", async () => {
  for (const requestContext of [undefined, {}, { authorizer: { role: "user", email: "u@example.com" } }]) {
    const sql = settingsSql();
    const res = await put(sql, { service_status: "read_only", service_message: "x" }, requestContext);
    assert.equal(res.statusCode, 403);
    assert.equal(sql.calls.length, 0);
  }
  // An admin role without the authorizer userId (Cognito sub) is refused too,
  // even when it carries an email.
  const sql = settingsSql();
  const res = await put(
    sql,
    { service_status: "banner", service_message: "x" },
    { authorizer: { role: "admin", email: "admin@example.com" } }
  );
  assert.equal(res.statusCode, 401);
  assert.equal(updateQuery(sql), undefined);
});

test("GET /admin/system-settings returns the service fields, and a normal fallback with no row", async () => {
  const get = (sql) =>
    invoke("adminHandler", sql, { httpMethod: "GET", resource: "/admin/system-settings", requestContext: adminContext });

  const withRow = settingsSql({ stored: { service_status: "banner", service_message: "Planned work." } });
  const res = await get(withRow);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.service_status, "banner");
  assert.equal(res.body.service_message, "Planned work.");
  const select = withRow.queries().find((q) => q.text.includes("LEFT JOIN users"));
  assert.match(select.text, /latest\.service_status, latest\.service_message/);

  const empty = await get(fakeSql(() => []));
  assert.equal(empty.body.service_status, "normal");
  assert.equal(empty.body.service_message, null);
});

// ── GET /system-settings/service-status (public, anonymous-token) ────────────

const getPublic = (sql) =>
  invoke("systemMessagesHandler", sql, {
    httpMethod: "GET",
    resource: "/system-settings/service-status",
    headers: { origin: TEST_ALLOWED_ORIGIN },
  });

test("the public read returns ONLY service_status and service_message, with a short public cache header", async () => {
  const sql = fakeSql(() => [
    {
      service_status: "banner",
      service_message: "Planned work tonight.",
      // Anything else the query might ever return must never reach a visitor.
      id: "s1",
      updated_by: "u1",
      updated_at: "2026-01-01",
      max_messages_per_day: 45,
      temperature: 0.15,
      email: "admin@example.com",
    },
  ]);
  const res = await getPublic(sql);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["service_message", "service_status"]);
  assert.deepEqual(res.body, { service_status: "banner", service_message: "Planned work tonight." });
  assert.equal(res.headers["Cache-Control"], "public, max-age=30");
  assert.equal(res.headers["Access-Control-Allow-Origin"], TEST_ALLOWED_ORIGIN, "CORS headers are kept");
});

test("the public read selects only the two columns", async () => {
  const sql = fakeSql(() => []);
  await getPublic(sql);
  const select = sql.queries()[0];
  assert.match(select.text, /^SELECT service_status, service_message FROM system_settings/);
});

test("the public read falls back to normal with no row, an unknown value, or a normal status", async () => {
  const none = await getPublic(fakeSql(() => []));
  assert.deepEqual(none.body, { service_status: "normal", service_message: null });

  const unknown = await getPublic(fakeSql(() => [{ service_status: "weird", service_message: "x" }]));
  assert.deepEqual(unknown.body, { service_status: "normal", service_message: null });

  // A leftover message is not shown while the status is normal.
  const normal = await getPublic(fakeSql(() => [{ service_status: "normal", service_message: "old" }]));
  assert.deepEqual(normal.body, { service_status: "normal", service_message: null });
});

test("the public character cap returns the stored value, or 2000 when the row is missing", async () => {
  const getCap = (sql) =>
    invoke("systemMessagesHandler", sql, {
      httpMethod: "GET",
      resource: "/system-settings/max-characters-per-user-message",
    });

  const stored = await getCap(fakeSql(() => [{ max_characters_per_user_message: 750 }]));
  assert.equal(stored.statusCode, 200);
  assert.deepEqual(stored.body, { max_characters_per_user_message: 750 });

  const missing = await getCap(fakeSql(() => []));
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.body, { max_characters_per_user_message: 2000 });
});

test("read_only is returned as-is", async () => {
  const res = await getPublic(fakeSql(() => [{ service_status: "read_only", service_message: "Chat is paused." }]));
  assert.deepEqual(res.body, { service_status: "read_only", service_message: "Chat is paused." });
});
