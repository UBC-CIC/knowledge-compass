/**
 * Unit tests for the per-IP WebSocket limits (websocket/ipLimit.js): address
 * bucketing (IPv4, IPv6 per /64, IPv4-mapped), the $connect handshake limit,
 * the $default generate_text limit shared by every guest on one address, that
 * the stored counter keys and logs never contain the address, and that every
 * fault fails closed:
 *
 *   node --test cdk/lambda/websocket/tests/ipLimit.test.js
 */

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  USER, IP_HASH_KEY, SOURCE_IP, accessToken, load, loadConnect, loadDefault, withEnv, quietly, captureConsole,
} = require("./_loadWebsocket.js");

const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const GUESTS = [
  USER,
  "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c",
  "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f",
];

const connectEvent = (sourceIp = SOURCE_IP, connectionId = "conn-1") => ({
  requestContext: {
    connectionId, domainName: "ws.example", stage: "prod", routeKey: "$connect",
    identity: sourceIp === null ? {} : { sourceIp },
  },
  headers: { "Sec-WebSocket-Protocol": `kc.v1, ${accessToken()}` },
});
const generateOn = (connectionId, userId, sourceIp = SOURCE_IP) => ({
  requestContext: {
    connectionId, domainName: "example.com", stage: "prod", routeKey: "$default",
    identity: { sourceIp },
  },
  body: JSON.stringify({ action: "generate_text", query: "hi", chat_session_id: SESSION, token: accessToken({ sub: userId }) }),
});
const puts = (calls) => calls.filter((c) => c.name === "PutItemCommand");
const ipKeys = (calls) =>
  [...new Set(
    calls.filter((c) => c.name === "UpdateItemCommand").map((c) => c.input.Key.connectionId.S).filter((k) => k.startsWith("ip#"))
  )];

let restoreEnv;
test.beforeEach(() => {
  restoreEnv = withEnv();
});
test.afterEach(() => restoreEnv());

const clock = (t) => {
  const state = { now: T0 };
  t.mock.method(Date, "now", () => state.now);
  return state;
};

test("ipBucket counts IPv4 per address, IPv6 per /64, and IPv4-mapped IPv6 as IPv4", () => {
  const { ipBucket } = load("ipLimit").module;
  assert.equal(ipBucket("203.0.113.7"), "4:203.0.113.7");
  assert.equal(ipBucket(" 203.0.113.7 "), "4:203.0.113.7");
  assert.equal(ipBucket("::ffff:203.0.113.7"), "4:203.0.113.7");
  assert.equal(ipBucket("::ffff:cb00:7107"), "4:203.0.113.7");
  assert.equal(ipBucket("0:0:0:0:0:ffff:cb00:7107"), "4:203.0.113.7");

  const prefix = "6:2001:db8:85a3:42::/64";
  for (const ip of [
    "2001:db8:85a3:42::1",
    "2001:0db8:85a3:0042:ffff:eeee:dddd:cccc",
    "2001:DB8:85A3:42:1:2:3:4",
    "2001:db8:85a3:42::192.0.2.1",
  ]) {
    assert.equal(ipBucket(ip), prefix, ip);
  }
  assert.notEqual(ipBucket("2001:db8:85a3:43::1"), prefix);
  assert.equal(ipBucket("::1"), "6:0:0:0:0::/64");

  for (const bad of [undefined, null, "", "not-an-ip", "203.0.113", "256.1.1.1", "2001:db8::1::2", 42]) {
    assert.equal(ipBucket(bad), null, String(bad));
  }
});

test("ipRateLimitConfig defaults to 30 connects and 30 messages per 60 s, and rejects bad values", () => {
  const { ipRateLimitConfig, IP_RATE_LIMIT_DEFAULTS } = load("ipLimit").module;
  assert.deepEqual(IP_RATE_LIMIT_DEFAULTS, { connect: 30, generate: 30, windowSeconds: 60 });
  assert.deepEqual(ipRateLimitConfig({}), {
    connect: { limit: 30, windowSeconds: 60 },
    generate: { limit: 30, windowSeconds: 60 },
  });
  assert.deepEqual(
    ipRateLimitConfig({ WS_IP_CONNECT_RATE_LIMIT: "5", WS_IP_GENERATE_RATE_LIMIT: "7", WS_IP_RATE_WINDOW_SECONDS: "30" }),
    { connect: { limit: 5, windowSeconds: 30 }, generate: { limit: 7, windowSeconds: 30 } }
  );
  assert.deepEqual(
    ipRateLimitConfig({ WS_IP_CONNECT_RATE_LIMIT: "0", WS_IP_GENERATE_RATE_LIMIT: "x", WS_IP_RATE_WINDOW_SECONDS: "-1" }),
    { connect: { limit: 30, windowSeconds: 60 }, generate: { limit: 30, windowSeconds: 60 } }
  );
});

test("$connect allows 30 handshakes per IP per window; the 31st is 429 before any token work", async (t) => {
  const time = clock(t);
  const { handler, connections, dynamoCalls } = loadConnect();
  for (let i = 1; i <= 30; i += 1) {
    const res = await quietly(() => handler(connectEvent(SOURCE_IP, `conn-${i}`)));
    assert.equal(res.statusCode, 200, `handshake ${i}`);
  }
  const before = puts(dynamoCalls).length;
  const over = await quietly(() => handler(connectEvent(SOURCE_IP, "conn-31")));
  assert.equal(over.statusCode, 429);
  assert.equal(over.headers, undefined);
  assert.equal(puts(dynamoCalls).length, before, "no binding is written");
  assert.equal(connections.has("conn-31"), false);

  // Another address is unaffected; the next window allows this one again.
  assert.equal((await quietly(() => handler(connectEvent("198.51.100.9", "conn-32")))).statusCode, 200);
  time.now = T0 + 60_000;
  assert.equal((await quietly(() => handler(connectEvent(SOURCE_IP, "conn-33")))).statusCode, 200);
});

test("handshakes with a bad or missing token still count against the IP", async (t) => {
  clock(t);
  process.env.WS_IP_CONNECT_RATE_LIMIT = "2";
  const { handler } = loadConnect();
  const noToken = (id) => ({ ...connectEvent(SOURCE_IP, id), headers: {} });
  assert.equal((await quietly(() => handler(noToken("c1")))).statusCode, 401);
  assert.equal((await quietly(() => handler(noToken("c2")))).statusCode, 401);
  assert.equal((await quietly(() => handler(connectEvent(SOURCE_IP, "c3")))).statusCode, 429);
});

test("IPv6 handshakes share one window per /64", async (t) => {
  clock(t);
  process.env.WS_IP_CONNECT_RATE_LIMIT = "2";
  const { handler } = loadConnect();
  assert.equal((await quietly(() => handler(connectEvent("2001:db8:1:2::a", "c1")))).statusCode, 200);
  assert.equal((await quietly(() => handler(connectEvent("2001:db8:1:2::b", "c2")))).statusCode, 200);
  assert.equal((await quietly(() => handler(connectEvent("2001:db8:1:2:ffff::c", "c3")))).statusCode, 429);
  assert.equal((await quietly(() => handler(connectEvent("2001:db8:1:3::a", "c4")))).statusCode, 200);
});

test("$connect fails closed with 500: no source IP, no secret configured, secret read or DynamoDB fault", async () => {
  const cases = [
    { event: connectEvent(null) },
    { event: connectEvent("not-an-ip") },
    { env: { WS_IP_HASH_SECRET: undefined } },
    { options: { ipSecretError: new Error("sm down") } },
    { options: { updateError: new Error("ddb throttled") } },
  ];
  for (const [index, { event = connectEvent(), env = {}, options }] of cases.entries()) {
    const restore = withEnv(env);
    try {
      const { handler, dynamoCalls, connections } = loadConnect(options);
      const res = await quietly(() => handler(event));
      assert.equal(res.statusCode, 500, `case ${index}`);
      assert.equal(puts(dynamoCalls).length, 0);
      assert.equal(connections.size, 0);
    } finally {
      restore();
    }
  }
});

test("$default: every guest on one IP shares 30 generate_text frames per window", async (t) => {
  const time = clock(t);
  const sockets = GUESTS.map((user, i) => [`conn-${i}`, user]);
  const { handler, invocations, posts } = loadDefault({ connections: new Map(sockets) });
  const statuses = [];
  // 8 frames per guest stays under the 10-per-guest limit; 32 in total.
  for (let round = 0; round < 8; round += 1) {
    for (const [connectionId, user] of sockets) {
      statuses.push((await quietly(() => handler(generateOn(connectionId, user)))).statusCode);
    }
  }
  assert.equal(statuses.filter((s) => s === 200).length, 30);
  assert.equal(statuses.filter((s) => s === 429).length, 2);
  assert.equal(invocations.length, 30);
  assert.ok(posts.every((p) => JSON.parse(p.Data).error === "RATE_LIMITED"));

  // A guest on another address is unaffected; the next window allows this one again.
  const other = loadDefault({ connections: new Map(sockets) });
  assert.equal((await quietly(() => other.handler(generateOn("conn-0", USER, "198.51.100.9")))).statusCode, 200);
  time.now = T0 + 60_000;
  assert.equal((await quietly(() => handler(generateOn("conn-0", USER)))).statusCode, 200);
});

test("$default: an IP limiter fault fails closed and nothing is invoked", async (t) => {
  clock(t);
  const connections = new Map([["conn-1", USER]]);
  for (const [env, options] of [
    [{ WS_IP_HASH_SECRET: undefined }, {}],
    [{}, { ipSecretError: new Error("sm down") }],
  ]) {
    const restore = withEnv(env);
    try {
      const { handler, invocations, posts } = loadDefault({ connections: new Map(connections), ...options });
      const res = await quietly(() => handler(generateOn("conn-1", USER)));
      assert.equal(res.statusCode, 500);
      assert.equal(invocations.length, 0);
      assert.equal(JSON.parse(posts[0].Data).error, "Internal server error");
    } finally {
      restore();
    }
  }
});

test("counter keys are an HMAC of the address under the secret key; the address is never stored or logged", async (t) => {
  clock(t);
  const ip = "198.51.100.23";
  const connect = loadConnect();
  const { output: connectLogs } = await captureConsole(() => connect.handler(connectEvent(ip)));
  const generate = loadDefault({ connections: new Map([["conn-1", USER]]) });
  const { output: generateLogs } = await captureConsole(() => generate.handler(generateOn("conn-1", USER, ip)));

  const digest = crypto.createHmac("sha256", IP_HASH_KEY).update(`4:${ip}`).digest("base64url");
  assert.deepEqual(ipKeys(connect.dynamoCalls), [`ip#connect#${digest}`]);
  assert.deepEqual(ipKeys(generate.dynamoCalls), [`ip#generate#${digest}`]);

  const stored = JSON.stringify([...connect.dynamoCalls, ...generate.dynamoCalls]);
  assert.equal(stored.includes(ip), false);
  for (const line of [...connectLogs, ...generateLogs]) assert.equal(line.includes(ip), false, line);

  // Over the limit, the rejection log carries only a reason code.
  process.env.WS_IP_CONNECT_RATE_LIMIT = "1";
  const limited = loadConnect();
  await quietly(() => limited.handler(connectEvent(ip)));
  const { result, output } = await captureConsole(() => limited.handler(connectEvent(ip, "conn-2")));
  assert.equal(result.statusCode, 429);
  assert.ok(output.some((line) => line.includes("ip_rate_limited")));
  for (const line of output) assert.equal(line.includes(ip), false, line);
});
