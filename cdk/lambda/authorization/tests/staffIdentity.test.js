/**
 * Unit tests for authorization/staffIdentity.js (staff users rows keyed on the
 * Cognito sub). Fake SQL client, no database:
 *
 *   node --test cdk/lambda/authorization/tests/staffIdentity.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql } = require("../../handlers/tests/_loadHandler.js");
const { ensureStaffUser, normalizeEmail } = require("../staffIdentity.js");

const SUB = "11111111-2222-3333-4444-555555555555";
const ROW = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const GUEST = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c";
const EMAIL = "admin@staff.example";

// `rows` maps a SQL text prefix to rows (or a function of values).
function staffSql({ bySub = [], holders = [] } = {}) {
  const sql = fakeSql((text, values) => {
    if (text.startsWith("SELECT id, email, role FROM users WHERE cognito_sub")) return bySub;
    if (text.startsWith("SELECT id, identity_source, cognito_sub, role")) return holders;
    if (text.startsWith("UPDATE users SET email = NULL")) {
      return holders.filter((h) => !values[1] || h.id !== values[1]).map((h) => ({ id: h.id }));
    }
    if (text.startsWith("UPDATE users SET cognito_sub")) return [{ id: values[2], email: EMAIL, role: values[1] }];
    if (text.startsWith("UPDATE users SET last_seen_at")) return [{ id: values[2], email: values[1], role: values[0] }];
    if (text.startsWith("INSERT INTO users")) return [{ id: values[0], email: values[1], role: values[3] }];
    return [];
  });
  sql.begin = async (fn) => fn(sql);
  return sql;
}

const texts = (sql) => sql.queries().map((q) => q.text);
const find = (sql, prefix) => sql.queries().find((q) => q.text.startsWith(prefix));

async function captureLogs(fn) {
  const lines = [];
  const saved = console.log;
  console.log = (...args) => lines.push(JSON.stringify(args));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = saved;
  }
}

test("normalizeEmail trims and lower-cases; empty and non-strings are null", () => {
  assert.equal(normalizeEmail("  A@B.Example "), "a@b.example");
  assert.equal(normalizeEmail("   "), null);
  assert.equal(normalizeEmail(undefined), null);
  assert.equal(normalizeEmail(42), null);
});

test("a missing sub throws before any query", async () => {
  for (const sub of [undefined, "", "   ", 7]) {
    const sql = staffSql();
    await assert.rejects(ensureStaffUser(sql, { sub, email: EMAIL, role: "admin" }), /requires a Cognito sub/);
    assert.equal(sql.queries().length, 0);
  }
});

test("sub hit: updates last_seen_at, keeps role unless elevating, no INSERT", async () => {
  const sql = staffSql({ bySub: [{ id: ROW, email: EMAIL, role: "student" }] });
  const kept = await ensureStaffUser(sql, { sub: SUB, email: EMAIL, role: "admin", elevate: false });
  assert.equal(kept.outcome, "existing");
  assert.equal(kept.role, "student");
  const update = find(sql, "UPDATE users SET last_seen_at = NOW()");
  assert.ok(update);
  assert.equal(update.values[0], "student");
  assert.ok(!texts(sql).some((t) => t.startsWith("INSERT INTO users")));
  assert.ok(!texts(sql).some((t) => t.includes("lower(email)")), "email is not consulted on a sub hit");

  const sql2 = staffSql({ bySub: [{ id: ROW, email: EMAIL, role: "student" }] });
  const elevated = await ensureStaffUser(sql2, { sub: SUB, email: EMAIL, role: "admin", elevate: true });
  assert.equal(elevated.role, "admin");
});

test("legacy cognito row without a sub or chats is linked and its credentials revoked", async () => {
  const sql = staffSql({
    holders: [{ id: ROW, identity_source: "cognito", cognito_sub: null, role: "admin", has_sessions: false }],
  });
  const row = await ensureStaffUser(sql, { sub: SUB, email: "Admin@Staff.Example", role: "admin" });
  assert.equal(row.outcome, "linked");
  assert.equal(row.id, ROW);
  const link = find(sql, "UPDATE users SET cognito_sub");
  assert.ok(link.text.includes("credential_version = credential_version + 1"));
  assert.equal(link.values[0], SUB);
  assert.ok(!texts(sql).some((t) => t.startsWith("INSERT INTO users")));
  const holders = find(sql, "SELECT id, identity_source");
  assert.equal(holders.values[0], EMAIL, "matched on the normalized email");
  assert.match(holders.text, /ORDER BY \(role = 'admin'::user_role\) DESC, id/);
});

test("elevate does not adopt a non-admin row that holds the email", async () => {
  const sql = staffSql({
    holders: [{ id: GUEST, identity_source: "cognito", cognito_sub: null, role: "student", has_sessions: false }],
  });
  const row = await ensureStaffUser(sql, { sub: SUB, email: EMAIL, role: "admin", elevate: true });
  assert.equal(row.outcome, "created");
  assert.notEqual(row.id, GUEST);
  assert.ok(!texts(sql).some((t) => t.startsWith("UPDATE users SET cognito_sub")));
  assert.ok(find(sql, "UPDATE users SET email = NULL"));
});

test("a guest row holding the email is detached, never linked, and a cognito row is created", async () => {
  const sql = staffSql({
    holders: [{ id: GUEST, identity_source: "guest", cognito_sub: null, role: "admin", has_sessions: false }],
  });
  const { result, lines } = await captureLogs(() =>
    ensureStaffUser(sql, { sub: SUB, email: EMAIL, displayName: "Pat Admin", role: "admin" })
  );
  assert.equal(result.outcome, "created");
  assert.notEqual(result.id, GUEST);
  assert.ok(!texts(sql).some((t) => t.startsWith("UPDATE users SET cognito_sub")));
  const detach = find(sql, "UPDATE users SET email = NULL");
  assert.deepEqual(detach.values, [EMAIL]);
  const insert = find(sql, "INSERT INTO users");
  assert.ok(insert.text.includes("'cognito'"));
  assert.ok(insert.values.includes(SUB));
  assert.ok(insert.values.includes("admin"));
  assert.ok(texts(sql).indexOf(detach.text) < texts(sql).indexOf(insert.text));
  for (const line of lines) {
    assert.ok(!line.includes(EMAIL) && !line.includes("Pat Admin") && !line.includes(GUEST), line);
  }
});

test("a guest row that owns chats or a cognito row with another sub is detached too", async () => {
  for (const holder of [
    { id: GUEST, identity_source: "cognito", cognito_sub: null, role: "admin", has_sessions: true },
    { id: GUEST, identity_source: "cognito", cognito_sub: "other-sub", role: "admin", has_sessions: false },
  ]) {
    const sql = staffSql({ holders: [holder] });
    const row = await captureLogs(() => ensureStaffUser(sql, { sub: SUB, email: EMAIL, role: "admin" }));
    assert.equal(row.result.outcome, "created", JSON.stringify(holder));
    assert.ok(find(sql, "UPDATE users SET email = NULL"));
  }
});

test("onWrite runs once inside the transaction for each outcome", async () => {
  const cases = [
    [{ bySub: [{ id: ROW, email: EMAIL, role: "student" }] }, "existing"],
    [{ holders: [{ id: ROW, identity_source: "cognito", cognito_sub: null, role: "admin", has_sessions: false }] }, "linked"],
    [{}, "created"],
  ];
  for (const [setup, outcome] of cases) {
    const sql = staffSql(setup);
    let inTx = false;
    const seenTx = [];
    sql.begin = async (fn) => {
      inTx = true;
      try {
        return await fn(sql);
      } finally {
        inTx = false;
      }
    };
    const calls = [];
    const result = await captureLogs(() =>
      ensureStaffUser(sql, {
        sub: SUB,
        email: EMAIL,
        role: "admin",
        elevate: true,
        onWrite: async (tx, row) => {
          seenTx.push(inTx);
          calls.push({ tx, row });
        },
      })
    );
    assert.equal(calls.length, 1, outcome);
    assert.equal(calls[0].tx, sql);
    assert.deepEqual(seenTx, [true], "called before the transaction resolves");
    assert.equal(calls[0].row.outcome, outcome);
    assert.deepEqual(calls[0].row, result.result);
  }
});

test("an onWrite that throws rejects ensureStaffUser", async () => {
  const sql = staffSql({ bySub: [{ id: ROW, email: EMAIL, role: "admin" }] });
  await assert.rejects(
    ensureStaffUser(sql, {
      sub: SUB,
      email: EMAIL,
      role: "admin",
      elevate: true,
      onWrite: async () => {
        throw new Error("audit insert failed");
      },
    }),
    /audit insert failed/
  );
});

test("no email: creates a cognito row with a null email without any email lookup", async () => {
  const sql = staffSql();
  const row = await ensureStaffUser(sql, { sub: SUB, role: "student" });
  assert.equal(row.outcome, "created");
  const insert = find(sql, "INSERT INTO users");
  assert.equal(insert.values[1], null);
  assert.ok(!texts(sql).some((t) => t.includes("lower(email)")));
});
