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

test("removed example endpoint and unknown routes are not served", async () => {
  for (const resource of ["/admin/exampleEndpoint", "/admin/does-not-exist"]) {
    const res = await invoke(fakeSql(), { httpMethod: "GET", resource, requestContext: adminContext });
    assert.notEqual(res.statusCode, 200, resource);
  }
});

// PUT /admin/system-settings is patch-style: the admin console sends only the
// keys that changed. postgres.js rejects `undefined` bindings, so the fake does too.
function settingsSql() {
  return fakeSql(
    (text) => {
      if (text.includes("FROM users")) return [{ id: "u1", role: "admin" }];
      if (text.startsWith("SELECT min_messages_before_suggest")) {
        return [{ min_messages_before_suggest: 4, min_exchanges_before_answer: 0 }];
      }
      if (text.includes("UPDATE system_settings")) return [{ id: "s1" }];
      return [];
    },
    { rejectUndefined: true }
  );
}

function putSettings(sql, patch) {
  return invoke(sql, {
    httpMethod: "PUT",
    resource: "/admin/system-settings",
    requestContext: adminContext,
    body: JSON.stringify(patch),
  });
}

const updateQuery = (sql) => sql.queries().find((q) => q.text.includes("UPDATE system_settings"));

test("system settings: a single-key patch updates without binding undefined", async () => {
  const sql = settingsSql();
  const res = await putSettings(sql, { max_messages_per_day: 50 });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const update = updateQuery(sql);
  assert.ok(update, "UPDATE was issued");
  assert.ok(!update.values.includes(undefined), "no undefined bindings");
  assert.ok(update.values.includes(50));
  assert.ok(update.values.includes("u1"));
});

test("system settings: each allowed key can be patched on its own", async () => {
  const singles = {
    max_messages_per_day: 50,
    min_messages_before_suggest: 3,
    routing_mode: "dynamic",
    min_exchanges_before_answer: 0,
    max_characters_per_user_message: 2000,
    max_characters_per_ai_message: 8000,
    temperature: 0.3,
    top_p: 0.6,
    support_score_threshold: 0.4,
    scope_alignment_score_threshold: 0.5,
    grounded_threshold: 0.7,
    partially_grounded_threshold: 0.4,
  };
  for (const [key, value] of Object.entries(singles)) {
    const sql = settingsSql();
    const res = await putSettings(sql, { [key]: value });
    assert.equal(res.statusCode, 200, `${key}: ${JSON.stringify(res.body)}`);
    assert.ok(updateQuery(sql).values.includes(value), key);
  }
});

test("system settings: a flow preset patch updates", async () => {
  const sql = settingsSql();
  const res = await putSettings(sql, {
    routing_mode: "dynamic",
    min_exchanges_before_answer: 1,
    min_messages_before_suggest: 3,
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(updateQuery(sql));
});

test("system settings: invalid patches return 400 without updating", async () => {
  const cases = [
    [{ temperature: 3 }, "temperature must be a number between 0 and 2"],
    [{ max_messages_per_day: null }, "max_messages_per_day must be an integer between 1 and 1000"],
    [{}, "No valid fields to update"],
  ];
  for (const [patch, error] of cases) {
    const sql = settingsSql();
    const res = await putSettings(sql, patch);
    assert.equal(res.statusCode, 400, JSON.stringify(patch));
    assert.deepEqual(res.body, { error });
    assert.equal(updateQuery(sql), undefined, "no UPDATE for invalid input");
  }
});
