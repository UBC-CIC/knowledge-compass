/**
 * Unit tests for websocket/default.js: every frame acts as the user the
 * connection was bound to at $connect, a connection without a binding is
 * refused and closed, and the payload sent to the text generation Lambda
 * carries only the sanitized query (never a client-sent is_intro_message,
 * which used to skip the guardrail, nor a client user_id) and the bound user
 * in requestContext.authorizer. AWS SDK clients and jsonwebtoken are replaced
 * by in-process fakes (see _loadWebsocket.js):
 *
 *   node --test cdk/lambda/websocket/tests/default.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { USER, accessToken, loadDefault, withEnv, quietly } = require("./_loadWebsocket.js");

const OTHER_USER = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c";
const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";

const bound = () => ({ connections: new Map([["conn-1", USER]]) });
const rawEvent = (body) => ({
  requestContext: { connectionId: "conn-1", domainName: "example.com", stage: "prod", routeKey: "$default" },
  body,
});
const wsEvent = (body) => rawEvent(JSON.stringify(body));
const generate = (extra = {}) =>
  wsEvent({ action: "generate_text", query: "hi", chat_session_id: SESSION, token: accessToken(), ...extra });
const errorCode = (post) => JSON.parse(post.Data).error;

let restoreEnv;
test.beforeEach(() => {
  restoreEnv = withEnv();
});
test.afterEach(() => restoreEnv());

test("client is_intro_message is not forwarded to text generation", async () => {
  const { handler, invocations } = loadDefault(bound());
  const res = await quietly(() =>
    handler(
      wsEvent({
        action: "generate_text",
        query: "  hello there  ",
        chat_session_id: SESSION,
        user_id: USER,
        token: accessToken(),
        is_intro_message: true,
      })
    )
  );

  assert.equal(res.statusCode, 200);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].InvocationType, "Event");
  const payload = JSON.parse(invocations[0].Payload);
  const body = JSON.parse(payload.body);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "is_intro_message"), false);
  assert.deepEqual(body, { query: "hello there" });
  assert.equal(payload.pathParameters.id, SESSION);
  assert.equal(payload.requestContext.authorizer.userId, USER);
});

test("payload without the flag has the same shape", async () => {
  const { handler, invocations } = loadDefault(bound());
  await quietly(() => handler(generate()));

  assert.equal(invocations.length, 1);
  assert.deepEqual(JSON.parse(JSON.parse(invocations[0].Payload).body), { query: "hi" });
});

test("missing token still sends an error event and does not invoke text generation", async () => {
  const { handler, invocations, posts, deletes } = loadDefault(bound());
  const res = await quietly(() =>
    handler(wsEvent({ action: "generate_text", query: "hi", chat_session_id: SESSION, is_intro_message: true }))
  );

  assert.equal(res.statusCode, 401);
  assert.equal(invocations.length, 0);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].Data).type, "error");
  assert.equal(deletes.length, 0, "a bad frame token does not close a bound socket");
});

test("a valid frame runs as the bound user and forwards no user_id", async () => {
  const { handler, invocations } = loadDefault(bound());
  const res = await quietly(() => handler(generate({ user_id: USER })));
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(invocations[0].Payload);
  assert.deepEqual(payload.requestContext.authorizer, { userId: USER });
  assert.deepEqual(JSON.parse(payload.body), { query: "hi" });
  assert.equal(payload.requestContext.connectionId, "conn-1");
});

test("generate_text on a connection with no record: error event, socket closed, nothing invoked", async () => {
  const { handler, invocations, posts, deletes } = loadDefault();
  const res = await quietly(() => handler(generate()));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: "CONNECTION_NOT_AUTHORIZED" });
  assert.equal(invocations.length, 0);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].Data), {
    type: "error",
    error: "CONNECTION_NOT_AUTHORIZED",
    message: "Your connection was refreshed. Please send your message again.",
  });
  assert.deepEqual(deletes, [{ ConnectionId: "conn-1" }]);
});

test("ping and garbage frames on an unbound connection are closed with 401 and no event", async () => {
  for (const event of [wsEvent({ type: "ping" }), wsEvent({ action: "other" }), rawEvent("not json")]) {
    const { handler, invocations, posts, deletes } = loadDefault();
    const res = await quietly(() => handler(event));
    assert.equal(res.statusCode, 401, event.body);
    assert.equal(posts.length, 0);
    assert.deepEqual(deletes, [{ ConnectionId: "conn-1" }]);
    assert.equal(invocations.length, 0);
  }
});

test("a frame token for another user is refused with CONNECTION_USER_MISMATCH", async () => {
  const { handler, invocations, posts, deletes } = loadDefault(bound());
  const res = await quietly(() => handler(generate({ token: accessToken({ sub: OTHER_USER }), user_id: OTHER_USER })));
  assert.equal(res.statusCode, 403);
  assert.equal(invocations.length, 0);
  assert.equal(errorCode(posts[0]), "CONNECTION_USER_MISMATCH");
  assert.equal(deletes.length, 0);
});

test("a frame user_id other than the bound user is refused, including empty string", async () => {
  for (const user_id of [OTHER_USER, "", 42]) {
    const { handler, invocations, posts, deletes } = loadDefault(bound());
    const res = await quietly(() => handler(generate({ user_id })));
    assert.equal(res.statusCode, 403, JSON.stringify(user_id));
    assert.equal(invocations.length, 0);
    assert.equal(errorCode(posts[0]), "user_id does not match the session token");
    assert.equal(deletes.length, 0);
  }
});

test("the binding lookup is a consistent read; a lookup error is 500 with a generic event", async () => {
  const ok = loadDefault(bound());
  await quietly(() => ok.handler(generate()));
  assert.equal(ok.dynamoCalls[0].name, "GetItemCommand");
  assert.equal(ok.dynamoCalls[0].input.ConsistentRead, true);
  assert.deepEqual(ok.dynamoCalls[0].input.Key, { connectionId: { S: "conn-1" } });

  const { handler, invocations, posts, deletes } = loadDefault({ connections: new Error("ddb down") });
  const res = await quietly(() => handler(generate()));
  assert.equal(res.statusCode, 500);
  assert.equal(invocations.length, 0);
  assert.equal(posts.length, 1);
  assert.equal(errorCode(posts[0]), "Internal server error");
  assert.equal(deletes.length, 0, "a lookup fault does not close the socket");
});

test("a secret fetch failure during frame verification is 500 with a generic event", async () => {
  const { handler, invocations, posts, deletes } = loadDefault({ ...bound(), secretError: new Error("sm down") });
  const res = await quietly(() => handler(generate()));
  assert.equal(res.statusCode, 500);
  assert.equal(invocations.length, 0);
  assert.equal(errorCode(posts[0]), "Internal server error");
  assert.equal(deletes.length, 0);
});

test("a query is truncated to the configured cap, including one above the old 10000 cutoff", async () => {
  const loaded = loadDefault(bound());
  const messageLimit = require("../messageLimit.js");
  messageLimit.getMaxCharactersPerUserMessage = async () => 12000;
  const res = await quietly(() => loaded.handler(generate({ query: "y".repeat(11000) })));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(JSON.parse(loaded.invocations[0].Payload).body);
  assert.equal(body.query.length, 11000);

  const capped = loadDefault(bound());
  require("../messageLimit.js").getMaxCharactersPerUserMessage = async () => 12;
  await quietly(() => capped.handler(generate({ query: "z".repeat(40) })));
  const short = JSON.parse(JSON.parse(capped.invocations[0].Payload).body);
  assert.equal(short.query, "z".repeat(12));
});

test("without a loaded cap the query is cut at 2000, not 10000", async () => {
  const { handler, invocations } = loadDefault(bound());
  const res = await quietly(() => handler(generate({ query: "x".repeat(2500) })));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(JSON.parse(invocations[0].Payload).body);
  assert.equal(body.query.length, 2000);
});

test("only the error event type is emitted", async () => {
  const { handler, posts } = loadDefault(bound());
  await quietly(() => handler(generate({ token: undefined })));
  await quietly(() => handler(generate({ token: accessToken({ sub: OTHER_USER }) })));
  await quietly(() => handler(generate({ user_id: OTHER_USER })));
  const unbound = loadDefault();
  await quietly(() => unbound.handler(generate()));
  for (const post of [...posts, ...unbound.posts]) assert.equal(JSON.parse(post.Data).type, "error");
});
