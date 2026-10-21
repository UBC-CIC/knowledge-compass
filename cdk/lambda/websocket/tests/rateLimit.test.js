/**
 * Unit tests for the per-connection generate_text rate limit in
 * websocket/default.js (fixed window on the WsConnections item, see
 * connections.js consumeGenerateAllowance). Over the limit a frame gets a
 * RATE_LIMITED error event and text generation is not invoked; a limiter fault
 * fails closed; pings are not counted:
 *
 *   node --test cdk/lambda/websocket/tests/rateLimit.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { USER, accessToken, load, loadDefault, withEnv, quietly } = require("./_loadWebsocket.js");

const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";
const RATE_LIMITED_MESSAGE = "You're sending messages a little quickly. Please wait a moment, then try again.";
// Start of a 60 s window, so +59 s stays in it and +60 s starts the next.
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

const bound = (extra = {}) => ({ connections: new Map([["conn-1", USER]]), ...extra });
const wsEvent = (body) => ({
  requestContext: { connectionId: "conn-1", domainName: "example.com", stage: "prod", routeKey: "$default" },
  body: JSON.stringify(body),
});
const generate = (extra = {}) =>
  wsEvent({ action: "generate_text", query: "hi", chat_session_id: SESSION, token: accessToken(), ...extra });
const updateCalls = (calls) => calls.filter((c) => c.name === "UpdateItemCommand");

let restoreEnv;
test.beforeEach(() => {
  restoreEnv = withEnv({ WS_GENERATE_RATE_LIMIT: undefined, WS_GENERATE_RATE_WINDOW_SECONDS: undefined });
});
test.afterEach(() => restoreEnv());

const clock = (t) => {
  const state = { now: T0 };
  t.mock.method(Date, "now", () => state.now);
  return state;
};

test("frames under the limit invoke text generation, up to and including the 10th", async (t) => {
  clock(t);
  const { handler, invocations, posts, rateState } = loadDefault(bound());
  for (let i = 1; i <= 10; i += 1) {
    const res = await quietly(() => handler(generate()));
    assert.equal(res.statusCode, 200, `frame ${i}`);
  }
  assert.equal(invocations.length, 10);
  assert.equal(posts.length, 0);
  assert.equal(rateState.get("conn-1").rlCount, 10);
});

test("the 11th frame in a window is RATE_LIMITED, not invoked, and the socket stays open", async (t) => {
  const time = clock(t);
  const { handler, invocations, posts, deletes } = loadDefault(bound());
  for (let i = 0; i < 10; i += 1) await quietly(() => handler(generate()));
  time.now = T0 + 59_000;

  const res = await quietly(() => handler(generate()));
  assert.equal(res.statusCode, 429);
  assert.deepEqual(JSON.parse(res.body), { error: "RATE_LIMITED" });
  assert.equal(invocations.length, 10);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].Data), { type: "error", error: "RATE_LIMITED", message: RATE_LIMITED_MESSAGE });
  assert.equal(deletes.length, 0);
});

test("a new window allows frames again", async (t) => {
  const time = clock(t);
  const { handler, invocations } = loadDefault(bound());
  for (let i = 0; i < 11; i += 1) await quietly(() => handler(generate()));
  assert.equal(invocations.length, 10);

  time.now = T0 + 60_000;
  const res = await quietly(() => handler(generate()));
  assert.equal(res.statusCode, 200);
  assert.equal(invocations.length, 11);
});

test("a DynamoDB error in the limiter fails closed with a generic error event", async (t) => {
  clock(t);
  const { handler, invocations, posts, deletes } = loadDefault(bound({ updateError: new Error("ddb throttled") }));
  const res = await quietly(() => handler(generate()));
  assert.equal(res.statusCode, 500);
  assert.equal(invocations.length, 0);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].Data).type, "error");
  assert.equal(JSON.parse(posts[0].Data).error, "Internal server error");
  assert.equal(deletes.length, 0);
});

test("a ping on a bound connection is unchanged: 400 Unknown action, no event, no UpdateItem", async (t) => {
  clock(t);
  const { handler, invocations, posts, deletes, dynamoCalls } = loadDefault(bound());
  for (let i = 0; i < 20; i += 1) {
    const res = await quietly(() => handler(wsEvent({ type: "ping" })));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "Unknown action" });
  }
  assert.equal(posts.length, 0);
  assert.equal(deletes.length, 0);
  assert.equal(invocations.length, 0);
  assert.equal(updateCalls(dynamoCalls).length, 0);

  // Pings did not consume the allowance.
  const res = await quietly(() => handler(generate()));
  assert.equal(res.statusCode, 200);
});

test("invalid generate_text frames still consume allowance", async (t) => {
  clock(t);
  const { handler, invocations, rateState } = loadDefault(bound());
  for (let i = 0; i < 10; i += 1) {
    const res = await quietly(() => handler(generate({ query: "   " })));
    assert.equal(res.statusCode, 400);
  }
  assert.equal(rateState.get("conn-1").rlCount, 10);
  const res = await quietly(() => handler(generate()));
  assert.equal(res.statusCode, 429);
  assert.equal(invocations.length, 0);
});

test("WS_GENERATE_RATE_LIMIT is honoured; invalid values fall back to 10", async (t) => {
  clock(t);
  process.env.WS_GENERATE_RATE_LIMIT = "2";
  const small = loadDefault(bound());
  const codes = [];
  for (let i = 0; i < 3; i += 1) codes.push((await quietly(() => small.handler(generate()))).statusCode);
  assert.deepEqual(codes, [200, 200, 429]);

  for (const value of ["0", "abc", "-5", "2.5", ""]) {
    process.env.WS_GENERATE_RATE_LIMIT = value;
    const { handler, invocations } = loadDefault(bound());
    for (let i = 0; i < 11; i += 1) await quietly(() => handler(generate()));
    assert.equal(invocations.length, 10, JSON.stringify(value));
  }
});

test("rateLimitConfig parses both env vars with safe defaults", () => {
  const { rateLimitConfig, RATE_LIMIT_DEFAULTS } = load("connections").module;
  assert.deepEqual(RATE_LIMIT_DEFAULTS, { limit: 10, windowSeconds: 60 });
  assert.deepEqual(rateLimitConfig({}), { limit: 10, windowSeconds: 60 });
  assert.deepEqual(rateLimitConfig({ WS_GENERATE_RATE_LIMIT: "3", WS_GENERATE_RATE_WINDOW_SECONDS: "30" }), {
    limit: 3,
    windowSeconds: 30,
  });
  assert.deepEqual(rateLimitConfig({ WS_GENERATE_RATE_LIMIT: "0", WS_GENERATE_RATE_WINDOW_SECONDS: "x" }), {
    limit: 10,
    windowSeconds: 60,
  });
});

test("every limiter UpdateItem requires an existing record, so none can create one", async (t) => {
  clock(t);
  const { handler, dynamoCalls } = loadDefault(bound());
  await quietly(() => handler(generate()));
  await quietly(() => handler(generate()));
  const updates = updateCalls(dynamoCalls);
  assert.ok(updates.length >= 2);
  for (const { input } of updates) {
    assert.equal(input.TableName, "test-connections");
    assert.deepEqual(input.Key, { connectionId: { S: "conn-1" } });
    assert.match(input.ConditionExpression, /^attribute_exists\(connectionId\) AND /);
  }

  const { module: store, rateState, connections } = load("connections", bound());
  const { consumeGenerateAllowance } = store;
  // Called directly with an id that has no record: refused, nothing written.
  assert.equal(await consumeGenerateAllowance("conn-unknown", { limit: 10, windowSeconds: 60 }), false);
  assert.equal(rateState.has("conn-unknown"), false);
  assert.equal(connections.has("conn-unknown"), false);
});
