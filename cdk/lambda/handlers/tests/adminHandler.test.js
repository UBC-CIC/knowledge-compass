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

test("removed example endpoint and unknown routes are not served", async () => {
  for (const resource of ["/admin/exampleEndpoint", "/admin/does-not-exist"]) {
    const res = await invoke(fakeSql(), { httpMethod: "GET", resource, requestContext: adminContext });
    assert.notEqual(res.statusCode, 200, resource);
  }
});
