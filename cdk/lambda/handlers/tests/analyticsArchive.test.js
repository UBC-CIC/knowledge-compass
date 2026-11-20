/**
 * Admin analytics adds analytics_archive (migration 048), the per-day counts
 * the retention job keeps for deleted guests, to every live count. Fake SQL
 * client, no database:
 *
 *   node --test cdk/lambda/handlers/tests/analyticsArchive.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler, quietly } = require("./_loadHandler.js");

const adminContext = { authorizer: { role: "admin", email: "admin@example.com" } };

async function analytics(queryStringParameters) {
  const sql = fakeSql(() => [{}]);
  const { handler } = loadHandler("adminHandler", sql);
  const res = await quietly(() =>
    handler({ httpMethod: "GET", resource: "/admin/analytics", requestContext: adminContext, queryStringParameters }),
  );
  return { res, queries: sql.queries() };
}

test("all-time totals add archived guests to every count", async () => {
  const { res, queries } = await analytics(undefined);
  assert.equal(res.statusCode, 200);
  const totals = queries.find((q) => q.text.includes("AS thumbs_down")).text;
  assert.match(totals, /\+ \(SELECT COUNT\(DISTINCT aa\.archive_user_id\)::int FROM analytics_archive aa WHERE aa\.sessions_created > 0\)\) AS users/);
  for (const column of ["sessions_created", "messages", "questions", "thumbs_up", "thumbs_down"]) {
    assert.match(totals, new RegExp(`COALESCE\\(SUM\\(aa\\.${column}\\), 0\\)::int FROM analytics_archive aa`), column);
  }
});

test("windowed totals add the archived days inside the window", async () => {
  const { res, queries } = await analytics({ timeRange: "180d" });
  assert.equal(res.statusCode, 200);
  const totals = queries.find((q) => q.text.startsWith("WITH archived AS")).text;
  assert.match(totals, /COUNT\(DISTINCT aa\.archive_user_id\) FILTER \(WHERE aa\.sessions_created > 0\)::int AS users/);
  assert.match(totals, /aa\.activity_date >= DATE_TRUNC\('day', \?::timestamp\) AND aa\.activity_date < \?::timestamp/);
  for (const column of ["users", "chat_sessions", "messages", "questions", "thumbs_up", "thumbs_down"]) {
    assert.match(totals, new RegExp(`\\+ archived\\.${column}\\) AS ${column}`), column);
  }
  assert.match(totals, /FROM archived$/);
});

test("the daily series adds archived counts per day", async () => {
  const { queries } = await analytics({ timeRange: "365d" });
  const series = queries.find((q) => q.text.includes("WITH date_series")).text;
  assert.match(series, /daily_archive AS \( SELECT aa\.activity_date AS date/);
  assert.match(series, /LEFT JOIN daily_archive da ON ds\.date = da\.date/);
  assert.match(
    series,
    /GREATEST\( COALESCE\(dcs\.session_users, 0\) \+ COALESCE\(da\.session_users, 0\), COALESCE\(dq\.question_users, 0\) \+ COALESCE\(da\.question_users, 0\) \)::int AS users/
  );
  for (const [live, column] of [["dq", "questions"], ["dcs", "chat_sessions"], ["df", "thumbs_up"], ["df", "thumbs_down"]]) {
    assert.match(series, new RegExp(`\\(COALESCE\\(${live}\\.${column}, 0\\) \\+ COALESCE\\(da\\.${column}, 0\\)\\)::int AS ${column}`), column);
  }
});
