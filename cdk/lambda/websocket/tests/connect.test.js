/**
 * Unit tests for websocket/connect.js: where the token may come from, which
 * tokens bind a connection, the stored binding, the subprotocol echo, and
 * that server faults are 500 (not 401):
 *
 *   node --test cdk/lambda/websocket/tests/connect.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { USER, accessToken, loadConnect, withEnv, quietly, captureConsole } = require("./_loadWebsocket.js");

const connectEvent = ({ headers, queryStringParameters, body } = {}) => ({
  requestContext: { connectionId: "conn-1", domainName: "ws.example", stage: "prod", routeKey: "$connect" },
  headers,
  queryStringParameters,
  body,
});
const viaSubprotocol = (token) => connectEvent({ headers: { "Sec-WebSocket-Protocol": `kc.v1, ${token}` } });
const puts = (dynamoCalls) => dynamoCalls.filter((c) => c.name === "PutItemCommand");

let restoreEnv;
test.beforeEach(() => {
  restoreEnv = withEnv();
});
test.afterEach(() => restoreEnv());

test("a valid subprotocol token binds the connection and kc.v1 is echoed", async () => {
  const { handler, connections, dynamoCalls } = loadConnect();
  const before = Math.floor(Date.now() / 1000);
  const res = await quietly(() => handler(viaSubprotocol(accessToken())));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.headers, { "Sec-WebSocket-Protocol": "kc.v1" });
  assert.equal(connections.get("conn-1"), USER);
  const item = puts(dynamoCalls)[0].input.Item;
  const expiresAt = Number(item.expiresAt.N);
  assert.ok(expiresAt >= before + 7500 && expiresAt <= Math.floor(Date.now() / 1000) + 7500);
});

test("the subprotocol header is found case-insensitively", async () => {
  const { handler, connections } = loadConnect();
  const res = await quietly(() =>
    handler(connectEvent({ headers: { "sec-websocket-protocol": `${accessToken()},kc.v1` } }))
  );
  assert.equal(res.statusCode, 200);
  assert.equal(connections.get("conn-1"), USER);
});

test("Authorization: Bearer binds the connection without a protocol echo", async () => {
  const { handler, connections } = loadConnect();
  const res = await quietly(() =>
    handler(connectEvent({ headers: { Authorization: `Bearer ${accessToken()}` } }))
  );
  assert.equal(res.statusCode, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(res, "headers"), false);
  assert.equal(connections.get("conn-1"), USER);
});

test("a token in the query string or body is ignored: 401 and nothing stored", async () => {
  const { handler, dynamoCalls } = loadConnect();
  for (const event of [
    connectEvent({ queryStringParameters: { token: accessToken() } }),
    connectEvent({ body: JSON.stringify({ token: accessToken() }) }),
    connectEvent({ headers: {}, queryStringParameters: { token: accessToken() } }),
  ]) {
    const res = await quietly(() => handler(event));
    assert.equal(res.statusCode, 401);
  }
  assert.equal(puts(dynamoCalls).length, 0);
});

test("unusable tokens and malformed subprotocol lists are refused with 401 and nothing stored", async () => {
  const { handler, dynamoCalls } = loadConnect();
  const cases = [
    viaSubprotocol(accessToken({ sub: undefined })), // anonymous bootstrap token
    viaSubprotocol(accessToken({ typ: "credential", aud: "kc-token-exchange" })),
    viaSubprotocol(accessToken({ typ: undefined })),
    viaSubprotocol(accessToken({ typ: "refresh" })),
    viaSubprotocol(accessToken({ iss: undefined })),
    viaSubprotocol(accessToken({ iss: "other-deployment" })),
    viaSubprotocol(accessToken({ aud: undefined })),
    viaSubprotocol(accessToken({ aud: "kc-token-exchange" })),
    viaSubprotocol(accessToken({}, "other-secret")),
    viaSubprotocol(accessToken({ exp: 1 })), // expired
    connectEvent({ headers: { "Sec-WebSocket-Protocol": accessToken() } }), // no kc.v1
    connectEvent({ headers: { "Sec-WebSocket-Protocol": "kc.v1" } }), // kc.v1 only
    connectEvent({ headers: { "Sec-WebSocket-Protocol": `kc.v1, ${accessToken()}, extra` } }),
    connectEvent({ headers: { "Sec-WebSocket-Protocol": `kc.v1, kc.v1, ${accessToken()}` } }),
    // A malformed subprotocol header is not rescued by a valid Bearer header.
    connectEvent({ headers: { "Sec-WebSocket-Protocol": "kc.v1", Authorization: `Bearer ${accessToken()}` } }),
    connectEvent({ headers: { Authorization: "Bearer " } }),
    connectEvent(),
  ];
  for (const event of cases) {
    const res = await quietly(() => handler(event));
    assert.equal(res.statusCode, 401, JSON.stringify(event.headers));
    assert.equal(res.headers, undefined);
  }
  assert.equal(puts(dynamoCalls).length, 0);
});

test("a connection-store failure refuses the handshake with 500", async () => {
  const { handler } = loadConnect({ connections: new Error("ddb down") });
  const res = await quietly(() => handler(viaSubprotocol(accessToken())));
  assert.equal(res.statusCode, 500);
  assert.equal(res.headers, undefined);
});

test("misconfiguration and Secrets Manager faults are 500, not 401", async () => {
  const restore = withEnv({ JWT_ISSUER: undefined });
  try {
    const { handler, dynamoCalls } = loadConnect();
    const res = await quietly(() => handler(viaSubprotocol(accessToken())));
    assert.equal(res.statusCode, 500);
    assert.equal(dynamoCalls.length, 0);
  } finally {
    restore();
  }

  const failing = loadConnect({ secretError: new Error("sm down") });
  const res = await quietly(() => failing.handler(viaSubprotocol(accessToken())));
  assert.equal(res.statusCode, 500);
  assert.equal(failing.dynamoCalls.length, 0);

  const restoreTable = withEnv({ CONNECTIONS_TABLE_NAME: undefined });
  try {
    const { handler } = loadConnect();
    assert.equal((await quietly(() => handler(viaSubprotocol(accessToken())))).statusCode, 500);
  } finally {
    restoreTable();
  }
});

test("logs never contain the token or the user id", async () => {
  const token = accessToken();
  const { handler } = loadConnect();
  const accepted = await captureConsole(() => handler(viaSubprotocol(token)));
  const rejected = await captureConsole(() => handler(viaSubprotocol(accessToken({ iss: "other" }))));
  const failed = await captureConsole(() =>
    loadConnect({ connections: new Error("ddb down") }).handler(viaSubprotocol(token))
  );
  const lines = [...accepted.output, ...rejected.output, ...failed.output];
  assert.ok(lines.length >= 3);
  for (const line of lines) {
    assert.equal(line.includes(USER), false, line);
    assert.equal(line.includes("signed:"), false, line);
    assert.equal(line.includes("Sec-WebSocket-Protocol"), false, line);
  }
});
