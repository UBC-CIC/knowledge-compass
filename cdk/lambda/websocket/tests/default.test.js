/**
 * Unit tests for websocket/default.js generate_text: the payload sent to the
 * text generation Lambda carries only the sanitized query (never a
 * client-sent is_intro_message, which used to skip the guardrail) and the
 * verified user in requestContext.authorizer. AWS SDK clients and
 * jsonwebtoken are replaced by in-process fakes:
 *
 *   node --test cdk/lambda/websocket/tests/default.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";
const SECRET = "test-jwt-secret";

// Tokens are "signed:<json>"; verify() checks the secret like the real library.
const fakeJwt = {
  verify: (token, secret) => {
    if (typeof token !== "string" || !token.startsWith("signed:")) throw new Error("jwt malformed");
    const { payload, secret: signedWith } = JSON.parse(token.slice("signed:".length));
    if (signedWith !== secret) throw new Error("invalid signature");
    return payload;
  },
};
const accessToken = (sub = USER) => `signed:${JSON.stringify({ payload: { typ: "access", sub }, secret: SECRET })}`;

function loadDefault() {
  const invocations = [];
  const posts = [];
  class FakeCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const fakes = {
    "@aws-sdk/client-lambda": {
      LambdaClient: class {
        async send(command) {
          invocations.push(command.input);
          return { StatusCode: 202 };
        }
      },
      InvokeCommand: FakeCommand,
    },
    "@aws-sdk/client-secrets-manager": {
      SecretsManagerClient: class {
        async send() {
          return { SecretString: JSON.stringify({ jwtSecret: SECRET }) };
        }
      },
      GetSecretValueCommand: FakeCommand,
    },
    "@aws-sdk/client-apigatewaymanagementapi": {
      ApiGatewayManagementApiClient: class {
        async send(command) {
          posts.push(command.input);
        }
      },
      PostToConnectionCommand: FakeCommand,
    },
    jsonwebtoken: fakeJwt,
  };

  const modulePath = path.resolve(__dirname, "..", "default.js");
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return { handler: require(modulePath).handler, invocations, posts };
  } finally {
    Module._load = originalLoad;
  }
}

// Silence handler console output during a test.
async function quietly(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const wsEvent = (body) => ({
  requestContext: { connectionId: "conn-1", domainName: "example.com", stage: "prod", routeKey: "$default" },
  body: JSON.stringify(body),
});

test("client is_intro_message is not forwarded to text generation", async () => {
  const { handler, invocations } = loadDefault();
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
  const { handler, invocations } = loadDefault();
  await quietly(() =>
    handler(wsEvent({ action: "generate_text", query: "hi", chat_session_id: SESSION, token: accessToken() }))
  );

  assert.equal(invocations.length, 1);
  assert.deepEqual(JSON.parse(JSON.parse(invocations[0].Payload).body), { query: "hi" });
});

test("missing token still sends an error event and does not invoke text generation", async () => {
  const { handler, invocations, posts } = loadDefault();
  const res = await quietly(() =>
    handler(wsEvent({ action: "generate_text", query: "hi", chat_session_id: SESSION, is_intro_message: true }))
  );

  assert.equal(res.statusCode, 401);
  assert.equal(invocations.length, 0);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].Data).type, "error");
});
