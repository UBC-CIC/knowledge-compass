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

test("admin re-check elevates a non-admin row of an admin-group caller, with an audit row", async () => {
  const sql = fakeSql((text, values) => {
    if (text.includes("FROM users")) return [{ id: "a1", email: "admin@example.com", role: "student" }];
    if (text.startsWith("UPDATE users")) return [{ id: "a1", email: values[1], role: values[0] }];
    if (text.includes("UPDATE system_settings")) return [{ id: "s1" }];
    return [];
  });
  const res = await settingsPut(sql);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const elevate = sql.queries().find((q) => q.text.startsWith("UPDATE users"));
  assert.equal(elevate.values[0], "admin");
  assert.ok(elevate.values.includes("a1"));
  const audit = sql.queries().find((q) => q.text.startsWith("INSERT INTO admin_audit"));
  assert.ok(audit, "elevation is audited");
  assert.ok(audit.values.includes("admin.promote_user"));
  assert.ok(audit.values.includes(ADMIN_SUB));
  assert.ok(!sql.queries().some((q) => /WHERE (lower\()?email/.test(q.text)), "no email-keyed lookup");
  assert.ok(updateQuery(sql).values.includes("a1"));
});

test("admin re-check: a row that cannot be elevated is 403, a missing sub is 401", async () => {
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

// --- Admin audit trail (finding f-0d57a9d0, migration 040) -----------------

const auditContext = { ...adminContext, requestId: "req-123" };
const auditInserts = (sql) => sql.queries().filter((q) => q.text.startsWith("INSERT INTO admin_audit"));

// Like invoke(), but returns the console.log lines that parse as admin audit entries.
async function invokeCapturing(sql, event) {
  const { handler } = loadHandler("adminHandler", sql);
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => lines.push(args.map(String).join(" "));
  console.error = console.warn = () => {};
  let res;
  try {
    res = await handler(event);
  } finally {
    Object.assign(console, saved);
  }
  const audits = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((l) => l && l.audit === "admin_action");
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : null, audits };
}

function promoteSql({ failAudit = false } = {}) {
  const sql = fakeSql((text, values) => {
    if (text.startsWith("INSERT INTO admin_audit") && failAudit) throw new Error("audit insert failed");
    if (text.startsWith("INSERT INTO users")) return [{ id: "new-row", email: values[1], role: values[3] }];
    if (text.startsWith("SELECT id, email, display_name, role")) return [{ id: values[0], role: "admin" }];
    return [];
  });
  return sql;
}

test("promote_user writes one audit row with the authorizer actor, never the body email", async () => {
  const sql = promoteSql();
  const res = await invokeCapturing(sql, {
    httpMethod: "POST",
    resource: "/admin/promote_user",
    requestContext: auditContext,
    body: JSON.stringify({ email: "other@example.com" }),
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const inserts = auditInserts(sql);
  assert.equal(inserts.length, 1);
  const [sub, email, action, target, requestId] = inserts[0].values;
  assert.equal(sub, ADMIN_SUB);
  assert.equal(email, "admin@example.com");
  assert.equal(action, "admin.promote_user");
  assert.deepEqual(JSON.parse(target), { user_id: "new-row", outcome: "created", role: "admin" });
  assert.equal(requestId, "req-123");
  assert.ok(!JSON.stringify(inserts[0].values).includes("other@example.com"));
  const texts = sql.queries().map((q) => q.text);
  assert.ok(
    texts.findIndex((t) => t.startsWith("INSERT INTO users")) < texts.findIndex((t) => t.startsWith("INSERT INTO admin_audit")),
    "audit after the write, inside the same transaction"
  );
  assert.equal(res.audits.length, 1);
  assert.equal(res.audits[0].actorSub, ADMIN_SUB);
  assert.equal(res.audits[0].requestId, "req-123");
});

// The status line (utils/logging.js logResponse) of one handler call.
async function statusLines(sql, event) {
  const { handler } = loadHandler("adminHandler", sql);
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => lines.push(args);
  console.error = console.warn = () => {};
  try {
    await handler(event);
  } finally {
    Object.assign(console, saved);
  }
  return lines
    .filter((args) => args.length === 1 && args[0] && typeof args[0] === "object" && "statusCode" in args[0])
    .map((args) => args[0]);
}

test("status lines name the acting admin's sub, never a body email (finding f-7f03f151)", async () => {
  const promoted = await statusLines(promoteSql(), {
    httpMethod: "POST",
    resource: "/admin/promote_user",
    requestContext: auditContext,
    body: JSON.stringify({ email: "other@example.com" }),
  });
  assert.deepEqual(promoted, [
    { statusCode: 200, resource: "/admin/promote_user", requestId: "req-123", actorSub: ADMIN_SUB },
  ]);

  const denied = await statusLines(fakeSql(() => []), {
    httpMethod: "POST",
    resource: "/admin/promote_user",
    requestContext: { requestId: "req-9", authorizer: { role: "user", userId: "guest-sub" } },
    body: JSON.stringify({ email: "other@example.com" }),
  });
  assert.deepEqual(denied, [
    { statusCode: 403, resource: "/admin/promote_user", requestId: "req-9", actorSub: "guest-sub" },
  ]);

  const anonymous = await statusLines(fakeSql(() => []), {
    httpMethod: "GET",
    resource: "/admin/analytics",
    requestContext: { requestId: "req-10" },
  });
  assert.deepEqual(anonymous, [{ statusCode: 403, resource: "/admin/analytics", requestId: "req-10", actorSub: null }]);
  assert.ok(!JSON.stringify([promoted, denied]).includes("other@example.com"));
});

test("status lines record whose transcript an admin read (finding f-c3162843)", async () => {
  const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";
  const [line] = await statusLines(fakeSql(() => []), {
    httpMethod: "GET",
    resource: "/admin/chat_sessions/{sessionId}/messages",
    pathParameters: { sessionId: SESSION },
    requestContext: auditContext,
  });
  assert.equal(line.actorSub, ADMIN_SUB);
  assert.deepEqual(line.target, { sessionId: SESSION });

  // Only id-shaped values are logged.
  const [odd] = await statusLines(fakeSql(() => []), {
    httpMethod: "GET",
    resource: "/admin/users/{userId}/chat_sessions",
    pathParameters: { userId: "someone@example.com <script>" },
    requestContext: auditContext,
  });
  assert.equal(odd.target, undefined);
});

test("promote_user: a failing audit insert is a 500 with no success log", async () => {
  const sql = promoteSql({ failAudit: true });
  const res = await invokeCapturing(sql, {
    httpMethod: "POST",
    resource: "/admin/promote_user",
    requestContext: auditContext,
    body: "{}",
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.audits.length, 0);
});

test("system settings audits the patched field names and never their values", async () => {
  const sql = settingsSql();
  const res = await invokeCapturing(sql, {
    httpMethod: "PUT",
    resource: "/admin/system-settings",
    requestContext: auditContext,
    body: JSON.stringify({ max_messages_per_day: 77, service_status: "normal" }),
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const inserts = auditInserts(sql);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].values[2], "system_settings.update");
  assert.deepEqual(JSON.parse(inserts[0].values[3]), {
    settings_id: "s1",
    fields: ["max_messages_per_day", "service_status"],
  });
  assert.ok(!JSON.stringify(res.audits).includes("77"));
  assert.equal(res.audits.length, 1);
});

test("system settings: a failing audit insert is a 500 with no success log", async () => {
  const sql = fakeSql((text) => {
    if (text.startsWith("INSERT INTO admin_audit")) throw new Error("audit insert failed");
    if (text.includes("FROM users")) return [{ id: "u1", role: "admin" }];
    if (text.includes("UPDATE system_settings")) return [{ id: "s1" }];
    return [];
  });
  const res = await invokeCapturing(sql, {
    httpMethod: "PUT",
    resource: "/admin/system-settings",
    requestContext: auditContext,
    body: JSON.stringify({ max_messages_per_day: 50 }),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.audits.length, 0);
});

test("validation failures write no audit row", async () => {
  const sql = settingsSql();
  const res = await invokeCapturing(sql, {
    httpMethod: "PUT",
    resource: "/admin/system-settings",
    requestContext: auditContext,
    body: JSON.stringify({ temperature: 9 }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(auditInserts(sql).length, 0);
  assert.equal(res.audits.length, 0);
});

const MSG_ID = "9d4c1f6e-0000-4000-8000-000000000001";
const PREV_ID = "9d4c1f6e-0000-4000-8000-000000000002";

function systemMessageSql({ isActive = false } = {}) {
  return fakeSql((text) => {
    if (text.includes("FROM users")) return [{ id: "u1", role: "admin" }];
    if (text.includes("AS next_version")) return [{ next_version: 3 }];
    if (text.startsWith("SELECT character_limit")) return [{ character_limit: 700 }];
    if (text.startsWith("INSERT INTO system_messages")) return [{ id: MSG_ID }];
    if (text.startsWith("SELECT id, type, version, is_active")) {
      return [{ id: MSG_ID, type: "welcome_message", version: 2, is_active: isActive }];
    }
    if (text.startsWith("SELECT id, version FROM system_messages")) return [{ id: PREV_ID, version: 1 }];
    if (text.startsWith("DELETE FROM system_messages")) return [{ id: MSG_ID, type: "welcome_message", version: 2 }];
    if (text.startsWith("SELECT sm.id")) return [{ id: MSG_ID, content: "secret prompt text" }];
    return [];
  });
}

test("system message create, delete and activate each write one audit row without content", async () => {
  const cases = [
    ["POST", "/admin/system-messages/{system_message_type}", { content: "secret prompt text" }, "system_message.create",
      { id: MSG_ID, type: "welcome_message", version: 3 }],
    ["DELETE", "/admin/system-messages/{system_message_type}/{version_id}", {}, "system_message.delete",
      { id: MSG_ID, type: "welcome_message", version: 2 }],
    ["POST", "/admin/system-messages/{system_message_type}/{version_id}/activate", {}, "system_message.activate",
      { id: MSG_ID, type: "welcome_message", version: 2, previous_active_id: PREV_ID }],
  ];
  for (const [httpMethod, resource, body, action, target] of cases) {
    const sql = systemMessageSql();
    const res = await invokeCapturing(sql, {
      httpMethod,
      resource,
      pathParameters: { system_message_type: "welcome_message", version_id: MSG_ID },
      requestContext: auditContext,
      body: JSON.stringify(body),
    });
    assert.equal(res.statusCode, 200, `${resource} ${JSON.stringify(res.body)}`);
    const inserts = auditInserts(sql);
    assert.equal(inserts.length, 1, resource);
    assert.equal(inserts[0].values[0], ADMIN_SUB);
    assert.equal(inserts[0].values[2], action);
    assert.deepEqual(JSON.parse(inserts[0].values[3]), target);
    assert.equal(res.audits.length, 1, resource);
    assert.ok(!JSON.stringify(inserts[0].values).includes("secret prompt text"));
    assert.ok(!JSON.stringify(res.audits).includes("secret prompt text"));
  }
});

test("activating the already-active version writes no audit row", async () => {
  const sql = systemMessageSql({ isActive: true });
  const res = await invokeCapturing(sql, {
    httpMethod: "POST",
    resource: "/admin/system-messages/{system_message_type}/{version_id}/activate",
    pathParameters: { system_message_type: "welcome_message", version_id: MSG_ID },
    requestContext: auditContext,
    body: "{}",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "already_active");
  assert.equal(auditInserts(sql).length, 0);
});
