/**
 * Unit tests for handlers/utils/adminAudit.js (admin_audit rows and log
 * lines, finding f-0d57a9d0). Fake SQL client, no database:
 *
 *   node --test cdk/lambda/handlers/tests/adminAudit.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql } = require("./_loadHandler.js");
const { auditEntry, insertAdminAudit, logAdminAudit } = require("../utils/adminAudit.js");

const SUB = "11111111-2222-3333-4444-555555555555";
const event = {
  body: JSON.stringify({ email: "attacker@example.com", userId: "body-sub" }),
  requestContext: {
    requestId: "req-1",
    authorizer: { userId: ` ${SUB} `, email: " Admin@Example.COM ", role: "admin" },
  },
};

test("auditEntry takes the actor from the authorizer only and ignores the body", () => {
  const entry = auditEntry(event, "admin.promote_user", { user_id: "u1" });
  assert.deepEqual(entry, {
    actorSub: SUB,
    actorEmail: "admin@example.com",
    action: "admin.promote_user",
    target: { user_id: "u1" },
    requestId: "req-1",
  });
  assert.ok(!JSON.stringify(entry).includes("attacker@example.com"));
});

test("auditEntry throws without an authorizer sub; requestId defaults to null", () => {
  for (const ctx of [undefined, {}, { authorizer: {} }, { authorizer: { userId: "  " } }]) {
    assert.throws(() => auditEntry({ requestContext: ctx }, "x"), /audit actor missing/);
  }
  const entry = auditEntry({ requestContext: { authorizer: { userId: SUB } } }, "x");
  assert.equal(entry.requestId, null);
  assert.equal(entry.actorEmail, null);
});

test("insertAdminAudit binds actor, action, JSON target and request id", async () => {
  const sql = fakeSql();
  await insertAdminAudit(sql, auditEntry(event, "system_settings.update", { settings_id: "s1", fields: ["a"] }));
  const [q] = sql.queries();
  assert.ok(q.text.startsWith("INSERT INTO admin_audit (actor_sub, actor_email, action, target, request_id)"));
  assert.ok(q.text.includes("::jsonb"));
  assert.deepEqual(q.values, [
    SUB,
    "admin@example.com",
    "system_settings.update",
    JSON.stringify({ settings_id: "s1", fields: ["a"] }),
    "req-1",
  ]);
});

test("logAdminAudit writes one JSON object with exactly the audit fields", () => {
  const lines = [];
  const saved = console.log;
  console.log = (...args) => lines.push(args);
  try {
    logAdminAudit(auditEntry(event, "data_source.delete", { data_source_id: "d1" }));
  } finally {
    console.log = saved;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 1);
  const parsed = JSON.parse(lines[0][0]);
  assert.deepEqual(Object.keys(parsed).sort(), ["action", "actorEmail", "actorSub", "audit", "requestId", "target"]);
  assert.equal(parsed.audit, "admin_action");
  assert.equal(parsed.actorSub, SUB);
});
