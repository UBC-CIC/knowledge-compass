/**
 * Unit tests for handlers/utils/journeyPrompts.js (validation, shaping and
 * request handling with a fake SQL client). No database needed:
 *
 *   node --test cdk/lambda/handlers/tests/journeyPrompts.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const jp = require("../utils/journeyPrompts.js");

const UUID = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";

// Minimal stand-in for the postgres.js tagged-template client.
function fakeSql(handler = () => []) {
  const calls = [];
  const sql = (strings, ...values) => {
    if (!Array.isArray(strings)) return { identifier: strings, values };
    const text = strings.join("?");
    calls.push({ text, values });
    return Promise.resolve(handler(text, values));
  };
  sql.begin = async (fn) => fn(sql);
  sql.calls = calls;
  return sql;
}

const adminEvent = (overrides = {}) => ({
  requestContext: { authorizer: { email: "admin@example.com", role: "admin" } },
  ...overrides,
});

async function call(sql, routeKey, event) {
  const response = { statusCode: 200, body: "" };
  const handled = await jp.handleJourneyRequest(sql, event, routeKey, response);
  return { handled, statusCode: response.statusCode, body: JSON.parse(response.body || "null") };
}

test("validateKey accepts upper-case keys and rejects reserved or malformed ones", () => {
  assert.equal(jp.validateKey("J3"), "J3");
  assert.equal(jp.validateKey("POST_SECONDARY"), "POST_SECONDARY");
  for (const bad of ["BOTH", "UNCLEAR", "UNKNOWN", "NONE", "j3", "", "A-B", "X".repeat(17), 3, null]) {
    assert.throws(() => jp.validateKey(bad), jp.InputError, String(bad));
  }
});

test("validateJourneyInput requires key and name on create", () => {
  assert.deepEqual(
    jp.validateJourneyInput({ key: "J3", name: " Planning ", description: "d\r\nx", sort_order: 3 }),
    { key: "J3", name: "Planning", description: "d\nx", sort_order: 3 }
  );
  assert.throws(() => jp.validateJourneyInput({ key: "J3" }), /name is required/);
  assert.throws(() => jp.validateJourneyInput({ name: "x" }), /key must be/);
  assert.throws(() => jp.validateJourneyInput({ key: "J3", name: "x".repeat(121) }), /at most 120/);
});

test("validateJourneyInput partial updates", () => {
  assert.deepEqual(jp.validateJourneyInput({ is_archived: true }, { partial: true }), { is_archived: true });
  assert.throws(() => jp.validateJourneyInput({ key: "J9" }, { partial: true }), /key cannot be changed/);
  assert.throws(() => jp.validateJourneyInput({}, { partial: true }), /No fields/);
  assert.throws(() => jp.validateJourneyInput({ name: "  " }, { partial: true }), /name cannot be empty/);
  assert.throws(() => jp.validateJourneyInput({ is_archived: "yes" }, { partial: true }), /true or false/);
  // is_archived is ignored on create
  assert.equal(jp.validateJourneyInput({ key: "J3", name: "x", is_archived: true }).is_archived, undefined);
});

test("validateClusterInput checks matches_when and ignores priority", () => {
  // priority was dropped in migration 026; old clients that still send it are ignored.
  assert.deepEqual(
    jp.validateClusterInput({ key: "P", name: "Applying", matches_when: "asks about college", priority: 2 }),
    { key: "P", name: "Applying", matches_when: "asks about college" }
  );
  assert.throws(() => jp.validateClusterInput({ key: "P", name: "x" }), /matches_when is required/);
  assert.throws(() => jp.validateClusterInput({ priority: 1 }, { partial: true }), /No fields to update/);
});

test("parseFeedbackRange", () => {
  assert.equal(jp.parseFeedbackRange(undefined), 30);
  assert.equal(jp.parseFeedbackRange("7d"), 7);
  assert.equal(jp.parseFeedbackRange("3m"), 90);
  assert.equal(jp.parseFeedbackRange("5y"), 365);
  assert.equal(jp.parseFeedbackRange("0d"), 1);
  assert.equal(jp.parseFeedbackRange("junk"), 30);
  assert.equal(jp.parseFeedbackRange("all"), null);
});

test("shapeTree nests clusters and versions under their owners", () => {
  const tree = jp.shapeTree(
    [{ id: "j1", key: "J1", name: "One", description: "", detection_signals: "", sort_order: 1, is_archived: false }],
    [{ id: "c1", journey_id: "j1", key: "A", name: "Alpha", matches_when: "m", sort_order: 1, is_archived: false }],
    [
      { id: "v2", field: "guidance", journey_id: "j1", cluster_id: null, content: "g2", character_limit: 6000, version: 2, is_active: true },
      { id: "v1", field: "guidance", journey_id: "j1", cluster_id: null, content: "g1", character_limit: 6000, version: 1, is_active: false },
      { id: "v3", field: "response_pattern", journey_id: null, cluster_id: "c1", content: "p", character_limit: 6000, version: 1, is_active: true },
    ]
  );
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].prompts.guidance.map((v) => v.id), ["v2", "v1"]);
  assert.deepEqual(tree[0].prompts.detective_questions, []);
  assert.equal(tree[0].prompts.guidance[0].owner_id, "j1");
  assert.equal(tree[0].clusters[0].prompts.response_pattern[0].content, "p");
});

test("shapeFeedback lists every catalog item with counts and keeps unknown keys", () => {
  const out = jp.shapeFeedback(
    [
      { kind: "journey", key: "J1", up: 3, down: 1, sessions: 4 },
      { kind: "journey", key: "OLD", up: 1, down: 0, sessions: 1 },
      { kind: "cluster", key: "C", up: 2, down: 1, sessions: 3 },
      { kind: "untagged", key: null, up: 0, down: 2, sessions: 2 },
    ],
    [{ id: "j1", key: "J1", name: "One", is_archived: false }, { id: "j2", key: "J2", name: "Two", is_archived: true }],
    [{ id: "c", journey_id: "j1", key: "C", name: "Now", is_archived: false }],
    30
  );
  assert.deepEqual(out.journeys.map((j) => [j.key, j.up, j.down]), [["J1", 3, 1], ["J2", 0, 0], ["OLD", 1, 0]]);
  assert.equal(out.clusters[0].journey_key, "J1");
  assert.deepEqual(out.untagged, { up: 0, down: 2, sessions: 2 });
  assert.equal(out.days, 30);
  // Counts only: no comment or message fields.
  assert.ok(!JSON.stringify(out).includes("comment"));
});

test("non-journey routes are not handled", async () => {
  const res = await call(fakeSql(), "GET /admin/analytics", adminEvent());
  assert.equal(res.handled, false);
});

test("validation errors return 400 before touching the database", async () => {
  const sql = fakeSql();
  const res = await call(sql, "POST /admin/journeys", adminEvent({ body: JSON.stringify({ key: "BOTH", name: "x" }) }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /cannot be one of/);
  assert.equal(sql.calls.length, 0);

  const bad = await call(sql, "PUT /admin/journeys/{journey_id}", adminEvent({ pathParameters: { journey_id: "nope" }, body: "{}" }));
  assert.equal(bad.statusCode, 400);

  const field = await call(sql, "POST /admin/journey-prompts", adminEvent({ body: JSON.stringify({ field: "role", owner_id: UUID, content: "x" }) }));
  assert.equal(field.statusCode, 400);
  assert.match(field.body.error, /field must be one of/);
});

test("missing admin email is 401", async () => {
  const res = await call(
    fakeSql(),
    "POST /admin/journeys",
    { requestContext: { authorizer: {} }, body: JSON.stringify({ key: "J3", name: "x" }) }
  );
  assert.equal(res.statusCode, 401);
});

test("duplicate journey key is 409", async () => {
  const sql = fakeSql((text) => {
    if (text.includes("FROM users")) return [{ id: UUID, role: "admin" }];
    if (text.includes("FROM journeys WHERE key")) return [{ "?column?": 1 }];
    return [];
  });
  const res = await call(sql, "POST /admin/journeys", adminEvent({ body: JSON.stringify({ key: "J1", name: "x" }) }));
  assert.equal(res.statusCode, 409);
});

test("cannot archive the last active journey", async () => {
  const sql = fakeSql((text) => {
    if (text.includes("FROM users")) return [{ id: UUID, role: "admin" }];
    if (text.includes("FOR UPDATE")) return [{ id: UUID, is_archived: false }];
    if (text.includes("AS others")) return [{ others: 0 }];
    return [];
  });
  const res = await call(
    sql,
    "PUT /admin/journeys/{journey_id}",
    adminEvent({ pathParameters: { journey_id: UUID }, body: JSON.stringify({ is_archived: true }) })
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /At least one journey/);
  assert.ok(!sql.calls.some((c) => c.text.startsWith("\n          UPDATE journeys")));
});

test("new prompt version over the character limit is rejected", async () => {
  const sql = fakeSql((text) => {
    if (text.includes("FROM users")) return [{ id: UUID, role: "admin" }];
    if (text.includes("FOR UPDATE")) return [{ id: UUID }];
    if (text.includes("next_version")) return [{ next_version: 2 }];
    if (text.includes("SELECT character_limit")) return [{ character_limit: 10 }];
    return [];
  });
  const res = await call(
    sql,
    "POST /admin/journey-prompts",
    adminEvent({ body: JSON.stringify({ field: "guidance", owner_id: UUID, content: "x".repeat(11) }) })
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.character_limit, 10);
  assert.ok(!sql.calls.some((c) => c.text.includes("INSERT INTO journey_prompt_versions")));
});

test("active versions cannot be deleted", async () => {
  const sql = fakeSql((text) => {
    if (text.includes("FROM users")) return [{ id: UUID, role: "admin" }];
    if (text.includes("FOR UPDATE")) return [{ id: UUID, field: "guidance", version: 1, is_active: true }];
    return [];
  });
  const res = await call(sql, "DELETE /admin/journey-prompts/{version_id}", adminEvent({ pathParameters: { version_id: UUID } }));
  assert.equal(res.statusCode, 400);
  assert.ok(!sql.calls.some((c) => c.text.includes("DELETE FROM")));
});

test("missing tables give a 503 hint", async () => {
  const sql = fakeSql(() => {
    const err = new Error("relation does not exist");
    err.code = "42P01";
    throw err;
  });
  const res = await call(sql, "GET /admin/journeys", adminEvent());
  assert.equal(res.statusCode, 503);
});
