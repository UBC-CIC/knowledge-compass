/**
 * Unit tests for handlers/retentionHandler.js with a fake SQL client:
 *
 *   node --test cdk/lambda/handlers/tests/retentionHandler.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler, quietly } = require("./_loadHandler.js");

const USER_A = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const USER_B = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c";

// Each element of `pages` is the victim list one batch's SELECT returns.
function retentionSql(pages, { usersDeleted } = {}) {
  let page = 0;
  return fakeSql((text, values) => {
    if (text.startsWith("SELECT u.id FROM users u")) {
      const rows = pages[page] ?? [];
      page += 1;
      return rows.map((id) => ({ id }));
    }
    if (text.startsWith("WITH victims AS")) return Object.assign([], { count: 3 });
    if (text.startsWith("DELETE FROM chat_messages")) return Object.assign([], { count: 10 });
    if (text.startsWith("DELETE FROM chat_sessions")) return Object.assign([], { count: 4 });
    if (text.startsWith("DELETE FROM users")) {
      return Object.assign([], { count: usersDeleted ?? values[0].length });
    }
    if (text.startsWith("DELETE FROM daily_usage_requests")) return Object.assign([], { count: 7 });
    if (text.startsWith("DELETE FROM user_daily_usage")) return Object.assign([], { count: 2 });
    return [];
  });
}

const run = (sql, context) => {
  const { handler } = loadHandler("retentionHandler", sql);
  return quietly(() => handler({}, context));
};

test("selects only idle guest students, oldest first, locking with SKIP LOCKED", async () => {
  const sql = retentionSql([[]]);
  await run(sql);
  const select = sql.queries().find((q) => q.text.startsWith("SELECT u.id FROM users u"));
  assert.match(select.text, /u\.identity_source = 'guest'/);
  assert.match(select.text, /u\.role = 'student'::user_role/);
  assert.match(select.text, /GREATEST\( u\.created_at, u\.last_seen_at, \(SELECT max\(GREATEST\(cs\.created_at, cs\.last_active_at\)\)/);
  assert.match(select.text, /< now\(\) - make_interval\(days => \?\)/);
  assert.match(select.text, /NOT EXISTS \(SELECT 1 FROM data_sources d WHERE d\.created_by = u\.id\)/);
  assert.match(select.text, /ORDER BY u\.created_at LIMIT \? FOR UPDATE OF u SKIP LOCKED/);
  assert.deepEqual(select.values, [90, 200]);
});

test("skips guests with starred feedback until it is unstarred", async () => {
  const sql = retentionSql([[]]);
  await run(sql);
  const select = sql.queries().find((q) => q.text.startsWith("SELECT u.id FROM users u"));
  assert.match(
    select.text,
    /NOT EXISTS \( SELECT 1 FROM session_feedback sf JOIN chat_sessions cs ON cs\.id = sf\.chat_session_id WHERE cs\.user_id = u\.id AND sf\.starred_at IS NOT NULL \)/
  );
});

test("archives, then deletes messages, sessions and users for the same ids", async () => {
  const sql = retentionSql([[USER_A, USER_B]]);
  const totals = await run(sql);

  const texts = sql.queries().map((q) => q.text);
  const order = [
    "SELECT u.id FROM users u",
    "WITH victims AS",
    "DELETE FROM chat_messages",
    "DELETE FROM chat_sessions",
    "DELETE FROM users",
  ].map((prefix) => texts.findIndex((t) => t.startsWith(prefix)));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), `order ${order}`);

  for (const prefix of ["WITH victims AS", "DELETE FROM chat_messages", "DELETE FROM chat_sessions", "DELETE FROM users"]) {
    const q = sql.queries().find((c) => c.text.startsWith(prefix));
    assert.deepEqual(q.values, [[USER_A, USER_B]], prefix);
  }
  const usersDelete = sql.queries().find((q) => q.text.startsWith("DELETE FROM users"));
  assert.match(usersDelete.text, /identity_source = 'guest' AND role = 'student'::user_role/);

  assert.deepEqual(
    { users: totals.users, sessions: totals.sessions, messages: totals.messages, archiveRows: totals.archiveRows },
    { users: 2, sessions: 4, messages: 10, archiveRows: 3 }
  );
});

test("the archive keeps per-day counts under a fresh id and skips evaluation sessions", async () => {
  const sql = retentionSql([[USER_A]]);
  await run(sql);
  const archive = sql.queries().find((q) => q.text.startsWith("WITH victims AS")).text;
  assert.match(archive, /nextval\('analytics_archive_user_seq'\) AS archive_user_id/);
  assert.match(archive, /INSERT INTO analytics_archive \( archive_user_id, activity_date, sessions_created, messages, questions, thumbs_up, thumbs_down \)/);
  assert.equal((archive.match(/WHERE cs\.eval_run_id IS NULL/g) || []).length, 3);
  assert.match(archive, /DATE_TRUNC\('day', cs\.created_at\)::date/);
  assert.match(archive, /DATE_TRUNC\('day', cm\.created_at\)::date/);
  assert.match(archive, /DATE_TRUNC\('day', sf\.updated_at\)::date/);
  assert.match(archive, /FILTER \(WHERE cm\.sender = 'user'\)/);
  // Nothing identifying is copied.
  const insertColumns = archive.split("INSERT INTO analytics_archive")[1].split(")")[0];
  assert.doesNotMatch(insertColumns, /(^|[\s,(])user_id\b|content|title|comment|metadata/);
});

test("each batch runs in its own transaction and full pages continue", async () => {
  const full = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const sql = retentionSql([full, [USER_A]]);
  let transactions = 0;
  const begin = sql.begin;
  sql.begin = async (fn) => {
    transactions += 1;
    return begin(fn);
  };
  const totals = await run(sql);
  assert.equal(transactions, 2);
  assert.equal(totals.batches, 2);
  assert.equal(totals.users, 201);
});

test("stops when a batch deletes nothing instead of re-reading the same rows", async () => {
  const full = Array.from({ length: 200 }, () => USER_A);
  const sql = retentionSql([full, full, full], { usersDeleted: 0 });
  const totals = await run(sql);
  assert.equal(totals.batches, 1);
});

test("does not start a batch when little time is left", async () => {
  const sql = retentionSql([[USER_A]]);
  const totals = await run(sql, { getRemainingTimeInMillis: () => 30_000 });
  assert.equal(totals.batches, 0);
  assert.equal(totals.stoppedEarly, true);
  assert.ok(!sql.queries().some((q) => q.text.startsWith("SELECT u.id FROM users u")));
});

test("prunes daily limit bookkeeping", async () => {
  const sql = retentionSql([[]]);
  const totals = await run(sql);
  const requests = sql.queries().find((q) => q.text.startsWith("DELETE FROM daily_usage_requests"));
  const usage = sql.queries().find((q) => q.text.startsWith("DELETE FROM user_daily_usage"));
  assert.deepEqual(requests.values, [2]);
  assert.match(usage.text, /usage_date < \(now\(\) AT TIME ZONE 'UTC'\)::date - \?::int/);
  assert.deepEqual(usage.values, [7]);
  assert.equal(totals.usageRequestsPruned, 7);
  assert.equal(totals.userDailyUsagePruned, 2);
});

test("logs counts only, never ids", async () => {
  const sql = retentionSql([[USER_A, USER_B]]);
  const { handler } = loadHandler("retentionHandler", sql);
  const logged = [];
  const saved = console.log;
  console.log = (...args) => logged.push(args.join(" "));
  try {
    await handler({}, undefined);
  } finally {
    console.log = saved;
  }
  const line = logged.find((l) => l.includes("guest_retention"));
  assert.ok(line);
  assert.ok(!logged.some((l) => l.includes(USER_A) || l.includes(USER_B)));
  assert.equal(JSON.parse(line).users, 2);
});

test("a database error is logged without detail and rethrown", async () => {
  const sql = fakeSql((text) => {
    if (text.startsWith("SELECT u.id FROM users u")) {
      throw Object.assign(new Error(`Key (id)=(${USER_A}) is still referenced`), { name: "PostgresError", code: "23503", severity: "ERROR" });
    }
    return [];
  });
  const { handler } = loadHandler("retentionHandler", sql);
  const errors = [];
  const saved = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await assert.rejects(handler({}, undefined), { code: "23503" });
  } finally {
    console.error = saved;
  }
  assert.ok(errors.length > 0);
  assert.ok(!errors.some((e) => e.includes(USER_A)));
});
