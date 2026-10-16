/**
 * Unit tests for websocket/accessToken.js (which tokens bind a connection) and
 * websocket/connections.js (the DynamoDB connection store):
 *
 *   node --test cdk/lambda/websocket/tests/modules.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { USER, accessToken, load, withEnv } = require("./_loadWebsocket.js");

const loadModule = (name, options) => {
  const loaded = load(name, options);
  return { ...loaded, mod: loaded.module };
};

test("verifyAccessToken returns sub only for this deployment's user-bound access tokens", async (t) => {
  t.after(withEnv());
  const { mod } = loadModule("accessToken");
  assert.equal(await mod.verifyAccessToken(accessToken()), USER);

  for (const token of [
    undefined,
    "",
    "garbage",
    accessToken({ sub: undefined }), // anonymous bootstrap token
    accessToken({ sub: "not-a-uuid" }),
    accessToken({ typ: "credential", aud: "kc-token-exchange" }),
    accessToken({ typ: undefined }),
    accessToken({ iss: undefined }),
    accessToken({ iss: "other-deployment" }),
    accessToken({ aud: undefined }),
    accessToken({ aud: "kc-token-exchange" }),
    accessToken({ exp: 1 }),
    accessToken({}, "other-secret"),
  ]) {
    assert.equal(await mod.verifyAccessToken(token), null, String(token));
  }
});

test("verifyAccessToken throws (server fault) when JWT_ISSUER is unset or the secret fetch fails", async (t) => {
  t.after(withEnv({ JWT_ISSUER: undefined }));
  const { mod } = loadModule("accessToken");
  await assert.rejects(mod.verifyAccessToken(accessToken()), /JWT_ISSUER is not configured/);

  process.env.JWT_ISSUER = "test-issuer";
  const failing = loadModule("accessToken", { secretError: new Error("sm down") });
  await assert.rejects(failing.mod.verifyAccessToken(accessToken()), /sm down/);
});

test("putConnection writes userId with a TTL past the 2 h connection limit", async (t) => {
  t.after(withEnv());
  const { mod, dynamoCalls, connections } = loadModule("connections");
  const now = Date.UTC(2026, 0, 1);
  await mod.putConnection("conn-1", USER, now);
  assert.equal(connections.get("conn-1"), USER);
  const { name, input } = dynamoCalls[0];
  assert.equal(name, "PutItemCommand");
  assert.equal(input.TableName, "test-connections");
  assert.equal(input.ConditionExpression, "attribute_not_exists(connectionId)");
  assert.deepEqual(input.Item, {
    connectionId: { S: "conn-1" },
    userId: { S: USER },
    expiresAt: { N: String(now / 1000 + 7500) },
    connectedAt: { S: new Date(now).toISOString() },
  });
  await assert.rejects(mod.putConnection("conn-1", USER, now), /conditional check failed/);
});

test("getConnectionUserId reads consistently and ignores missing or malformed records", async (t) => {
  t.after(withEnv());
  const { mod, dynamoCalls } = loadModule("connections", {
    connections: new Map([["conn-1", USER], ["conn-bad", "not-a-uuid"]]),
  });
  assert.equal(await mod.getConnectionUserId("conn-1"), USER);
  assert.equal(dynamoCalls[0].input.ConsistentRead, true);
  assert.deepEqual(dynamoCalls[0].input.Key, { connectionId: { S: "conn-1" } });
  assert.equal(await mod.getConnectionUserId("conn-missing"), null);
  assert.equal(await mod.getConnectionUserId("conn-bad"), null);
});

test("deleteConnection removes the record; DynamoDB errors propagate", async (t) => {
  t.after(withEnv());
  const { mod, connections } = loadModule("connections", { connections: new Map([["conn-1", USER]]) });
  await mod.deleteConnection("conn-1");
  assert.equal(connections.has("conn-1"), false);

  const failing = loadModule("connections", { connections: new Error("ddb down") });
  await assert.rejects(failing.mod.getConnectionUserId("conn-1"), /ddb down/);
});

test("every connection-store call fails closed without CONNECTIONS_TABLE_NAME", async (t) => {
  t.after(withEnv({ CONNECTIONS_TABLE_NAME: undefined }));
  const { mod, dynamoCalls } = loadModule("connections");
  for (const call of [
    () => mod.putConnection("conn-1", USER),
    () => mod.getConnectionUserId("conn-1"),
    () => mod.deleteConnection("conn-1"),
  ]) {
    await assert.rejects(call(), /CONNECTIONS_TABLE_NAME is not configured/);
  }
  assert.equal(dynamoCalls.length, 0);
});
