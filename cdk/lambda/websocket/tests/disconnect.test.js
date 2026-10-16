/**
 * Unit tests for websocket/disconnect.js: the connection binding is deleted,
 * and a failed delete is logged by error name only and still returns 200:
 *
 *   node --test cdk/lambda/websocket/tests/disconnect.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { USER, loadDisconnect, withEnv, quietly, captureConsole } = require("./_loadWebsocket.js");

const disconnectEvent = () => ({
  requestContext: { connectionId: "conn-1", domainName: "ws.example", stage: "prod", routeKey: "$disconnect" },
});

let restoreEnv;
test.beforeEach(() => {
  restoreEnv = withEnv();
});
test.afterEach(() => restoreEnv());

test("disconnect deletes the connection record", async () => {
  const { handler, connections, dynamoCalls } = loadDisconnect({ connections: new Map([["conn-1", USER]]) });
  const res = await quietly(() => handler(disconnectEvent()));
  assert.equal(res.statusCode, 200);
  assert.equal(connections.has("conn-1"), false);
  assert.equal(dynamoCalls[0].name, "DeleteItemCommand");
  assert.deepEqual(dynamoCalls[0].input.Key, { connectionId: { S: "conn-1" } });
});

test("a failed delete still returns 200 and logs only the error name", async () => {
  const failure = Object.assign(new Error("secret detail"), { name: "ProvisionedThroughputExceededException" });
  const { handler } = loadDisconnect({ connections: failure });
  const { result, output } = await captureConsole(() => handler(disconnectEvent()));
  assert.equal(result.statusCode, 200);
  assert.ok(output.some((line) => line.includes("ProvisionedThroughputExceededException")));
  assert.equal(output.some((line) => line.includes("secret detail")), false);
});
