/**
 * Evaluation-harness sessions (chat_sessions.eval_run_id, migration 035) are
 * test traffic: every admin analytics count and the journey feedback counts
 * must exclude them. Fake SQL client, no database:
 *
 *   node --test cdk/lambda/handlers/tests/evalExclusion.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler, quietly } = require("./_loadHandler.js");
const jp = require("../utils/journeyPrompts.js");

const adminContext = { authorizer: { role: "admin", email: "admin@example.com" } };
const EXCLUDE = "cs.eval_run_id IS NULL";

async function analytics(queryStringParameters) {
  const sql = fakeSql(() => [{}]);
  const { handler } = loadHandler("adminHandler", sql);
  const res = await quietly(() =>
    handler({ httpMethod: "GET", resource: "/admin/analytics", requestContext: adminContext, queryStringParameters }),
  );
  return { res, queries: sql.queries() };
}

// Each count subquery / CTE, split so a filter on one cannot satisfy another.
function countBlocks(text) {
  return text
    .split(/\(\s*SELECT|\bAS \(/)
    .slice(1)
    .filter((block) => /FROM (chat_sessions|chat_messages|session_feedback)/.test(block));
}

test("all-time totals exclude eval sessions from every count", async () => {
  const { res, queries } = await analytics(undefined);
  assert.equal(res.statusCode, 200);
  const totals = queries.find((q) => q.text.includes("AS thumbs_down"));
  const blocks = countBlocks(totals.text);
  assert.equal(blocks.length, 6);
  for (const block of blocks) assert.ok(block.includes(EXCLUDE), block);
});

test("windowed totals and the daily series exclude eval sessions", async () => {
  const { res, queries } = await analytics({ timeRange: "30d" });
  assert.equal(res.statusCode, 200);

  const series = queries.find((q) => q.text.includes("WITH date_series"));
  const seriesBlocks = countBlocks(series.text);
  assert.equal(seriesBlocks.length, 3, "daily sessions, questions, feedback");
  for (const block of seriesBlocks) assert.ok(block.includes(EXCLUDE), block);

  const totals = queries.find((q) => q.text.includes("AS thumbs_down") && !q.text.includes("WITH date_series"));
  const totalBlocks = countBlocks(totals.text);
  assert.equal(totalBlocks.length, 6);
  for (const block of totalBlocks) assert.ok(block.includes(EXCLUDE), block);
});

test("message and feedback counts join chat_sessions to apply the filter", async () => {
  const { queries } = await analytics({ timeRange: "7d" });
  for (const q of queries.filter((x) => x.text.includes("AS thumbs_down"))) {
    for (const block of countBlocks(q.text)) {
      if (/FROM (chat_messages|session_feedback)/.test(block)) {
        assert.match(block, /JOIN chat_sessions cs ON cs\.id = (cm|sf)\.chat_session_id/);
      }
    }
  }
});

test("journey feedback counts exclude eval sessions", async () => {
  const calls = [];
  const sql = (strings, ...values) => {
    if (!Array.isArray(strings)) return { identifier: strings, values };
    calls.push(strings.join("?"));
    return Promise.resolve([]);
  };
  sql.begin = async (fn) => fn(sql);
  const response = { statusCode: 200, body: "" };
  await jp.handleJourneyRequest(
    sql,
    { requestContext: adminContext, queryStringParameters: { timeRange: "30d" } },
    "GET /admin/journeys/feedback",
    response,
  );
  const counts = calls.find((text) => text.includes("FROM session_feedback sf"));
  assert.ok(counts, "feedback count query issued");
  assert.ok(counts.includes(EXCLUDE));
  // The time filter stays grouped so the exclusion applies to all rows.
  assert.match(counts, /WHERE \(\?::timestamptz IS NULL OR sf\.updated_at >= \?::timestamptz\)\s+-- [^\n]*\n\s+AND cs\.eval_run_id IS NULL/);
});
