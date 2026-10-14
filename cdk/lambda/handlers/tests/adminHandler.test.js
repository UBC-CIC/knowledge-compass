/**
 * Unit tests for handlers/adminHandler.js authorization gate and routing,
 * using a fake SQL client. No database:
 *
 *   node --test cdk/lambda/handlers/tests/adminHandler.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler, quietly } = require("./_loadHandler.js");

async function invoke(sql, event) {
  const { handler } = loadHandler("adminHandler", sql);
  const res = await quietly(() => handler(event));
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const adminContext = { authorizer: { role: "admin", email: "admin@example.com" } };

test("non-admin callers are rejected before any database access", async () => {
  for (const requestContext of [undefined, {}, { authorizer: { role: "user" } }, { authorizer: { role: "Admin " } }]) {
    const sql = fakeSql();
    const res = await invoke(sql, { httpMethod: "GET", resource: "/admin/users", requestContext });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "Admin access required" });
    assert.equal(sql.calls.length, 0, "no connection or query for non-admins");
  }
});

test("admin can list users", async () => {
  const rows = [{ id: "u1", email: "a@example.com", role: "admin" }];
  const sql = fakeSql((text) => (text.includes("FROM users") ? rows : []));
  const res = await invoke(sql, { httpMethod: "GET", resource: "/admin/users", requestContext: adminContext });
  assert.equal(res.statusCode, 200);
  assert.ok(sql.queries().some((q) => q.text.includes("FROM users")));
});

test("system settings rejects an out-of-range daily character limit", async () => {
  const sql = fakeSql();
  const res = await invoke(sql, {
    httpMethod: "PUT",
    resource: "/admin/system-settings",
    requestContext: adminContext,
    body: JSON.stringify({ max_characters_per_day: 0 }),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /max_characters_per_day/);
  assert.ok(!sql.queries().some((q) => q.text.includes("UPDATE system_settings")));
});

test("system settings saves the daily character limit", async () => {
  const sql = fakeSql((text) => {
    if (text.includes("UPDATE system_settings")) return [{ id: "s1", max_characters_per_day: 10000 }];
    if (text.includes("FROM users")) return [{ id: "a1", role: "admin" }];
    return [];
  });
  const res = await invoke(sql, {
    httpMethod: "PUT",
    resource: "/admin/system-settings",
    requestContext: adminContext,
    body: JSON.stringify({ max_characters_per_day: 10000 }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.max_characters_per_day, 10000);
  const update = sql.queries().find((q) => q.text.includes("UPDATE system_settings"));
  assert.ok(update, "UPDATE query issued");
  assert.ok(update.text.includes("max_characters_per_day = COALESCE"));
  assert.ok(update.values.includes(10000));
});

test("system settings GET falls back to the default daily character limit", async () => {
  const res = await invoke(fakeSql(), { httpMethod: "GET", resource: "/admin/system-settings", requestContext: adminContext });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.max_characters_per_day, 10000);
});

test("system settings rejects an out-of-range global daily message budget", async () => {
  for (const value of [0, 1000001, 2.5, "5000"]) {
    const sql = fakeSql();
    const res = await invoke(sql, {
      httpMethod: "PUT",
      resource: "/admin/system-settings",
      requestContext: adminContext,
      body: JSON.stringify({ max_messages_per_day_global: value }),
    });
    assert.equal(res.statusCode, 400, String(value));
    assert.match(res.body.error, /max_messages_per_day_global/);
    assert.ok(!sql.queries().some((q) => q.text.includes("UPDATE system_settings")));
  }
});

test("system settings saves the global daily message budget", async () => {
  const sql = fakeSql((text) => {
    if (text.includes("UPDATE system_settings")) return [{ id: "s1", max_messages_per_day_global: 1234 }];
    if (text.includes("FROM users")) return [{ id: "a1", role: "admin" }];
    return [];
  });
  const res = await invoke(sql, {
    httpMethod: "PUT",
    resource: "/admin/system-settings",
    requestContext: adminContext,
    body: JSON.stringify({ max_messages_per_day_global: 1234 }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.max_messages_per_day_global, 1234);
  const update = sql.queries().find((q) => q.text.includes("UPDATE system_settings"));
  assert.ok(update, "UPDATE query issued");
  assert.ok(update.text.includes("max_messages_per_day_global = COALESCE"));
  assert.ok(update.text.includes("s.max_messages_per_day_global"), "returned in RETURNING");
  assert.ok(update.values.includes(1234));
});

test("system settings GET returns the global daily message budget", async () => {
  const fallback = await invoke(fakeSql(), { httpMethod: "GET", resource: "/admin/system-settings", requestContext: adminContext });
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.body.max_messages_per_day_global, 5000);

  const sql = fakeSql((text) => (text.includes("FROM system_settings") ? [{ id: "s1", max_messages_per_day_global: 250 }] : []));
  const res = await invoke(sql, { httpMethod: "GET", resource: "/admin/system-settings", requestContext: adminContext });
  assert.equal(res.body.max_messages_per_day_global, 250);
  assert.ok(sql.queries().some((q) => q.text.includes("latest.max_messages_per_day_global")));
});

test("removed example endpoint and unknown routes are not served", async () => {
  for (const resource of ["/admin/exampleEndpoint", "/admin/does-not-exist"]) {
    const res = await invoke(fakeSql(), { httpMethod: "GET", resource, requestContext: adminContext });
    assert.notEqual(res.statusCode, 200, resource);
  }
});
