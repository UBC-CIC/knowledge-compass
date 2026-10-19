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

const ADMIN_SUB = "11111111-2222-3333-4444-555555555555";
const adminContext = { authorizer: { role: "admin", email: "admin@example.com", userId: ADMIN_SUB } };

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

// ── Admin identity is the Cognito sub, never users.email (finding f-23c5bf7c) ──

const settingsPut = (sql, requestContext = adminContext) =>
  invoke(sql, {
    httpMethod: "PUT",
    resource: "/admin/system-settings",
    requestContext,
    body: JSON.stringify({ max_messages_per_day: 50 }),
  });

test("admin re-check selects by the authorizer sub and never by email", async () => {
  const sql = fakeSql((text) => {
    if (text.includes("FROM users")) return [{ id: "a1", role: "admin" }];
    if (text.includes("UPDATE system_settings")) return [{ id: "s1" }];
    return [];
  });
  const res = await settingsPut(sql);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const lookup = sql.queries().find((q) => q.text.includes("FROM users WHERE cognito_sub"));
  assert.ok(lookup, "looked up by cognito_sub");
  assert.deepEqual(lookup.values, [ADMIN_SUB]);
  assert.ok(!sql.queries().some((q) => /WHERE (lower\()?email/.test(q.text)), "no email-keyed lookup");
  assert.ok(updateQuery(sql).values.includes("a1"));
});

test("admin re-check on a sub miss creates the cognito row instead of matching by email", async () => {
  const sql = fakeSql((text, values) => {
    if (text.startsWith("INSERT INTO users")) return [{ id: values[0], email: values[1], role: values[3] }];
    if (text.includes("UPDATE system_settings")) return [{ id: "s1" }];
    return [];
  });
  sql.begin = async (fn) => fn(sql);
  const res = await settingsPut(sql);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const insert = sql.queries().find((q) => q.text.startsWith("INSERT INTO users"));
  assert.ok(insert.text.includes("'cognito'"));
  assert.ok(insert.values.includes(ADMIN_SUB));
  assert.equal(insert.values[3], "admin");
});

test("admin re-check: a row whose role is not admin is 403, a missing sub is 401", async () => {
  const student = fakeSql((text) => (text.includes("FROM users") ? [{ id: "a1", role: "student" }] : []));
  const res = await settingsPut(student);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "User is not an admin" });
  assert.equal(updateQuery(student), undefined);

  const noSub = fakeSql();
  const res401 = await settingsPut(noSub, { authorizer: { role: "admin", email: "admin@example.com" } });
  assert.equal(res401.statusCode, 401);
  assert.equal(noSub.queries().length, 0);
});

test("promote_user acts only on the caller's sub and ignores body email and role", async () => {
  const sql = fakeSql((text, values) => {
    if (text.startsWith("INSERT INTO users")) return [{ id: "new-row", email: values[1], role: values[3] }];
    if (text.startsWith("SELECT id, email, display_name, role")) return [{ id: values[0], role: "admin" }];
    return [];
  });
  sql.begin = async (fn) => fn(sql);
  const res = await invoke(sql, {
    httpMethod: "POST",
    resource: "/admin/promote_user",
    requestContext: adminContext,
    body: JSON.stringify({ email: "other@example.com", role: "student", user_id: "victim" }),
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, "new-row");
  for (const q of sql.queries()) {
    const bound = JSON.stringify(q.values);
    assert.ok(!bound.includes("other@example.com") && !bound.includes("victim"), q.text);
    assert.ok(!q.text.includes("ON CONFLICT (email)"), q.text);
  }
  const insert = sql.queries().find((q) => q.text.startsWith("INSERT INTO users"));
  assert.ok(insert.values.includes(ADMIN_SUB));
  assert.equal(insert.values[3], "admin");

  const noSub = fakeSql();
  const res401 = await invoke(noSub, {
    httpMethod: "POST",
    resource: "/admin/promote_user",
    requestContext: { authorizer: { role: "admin", email: "admin@example.com" } },
    body: "{}",
  });
  assert.equal(res401.statusCode, 401);
  assert.equal(noSub.queries().length, 0);
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
    max_messages_per_day_global: 1234,
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
