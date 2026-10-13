/**
 * Unit tests for the anonymous-user token flow:
 *   userAuthorizer       - refuses credentials, exposes only the bound userId
 *   websocket/default.js - binds text generation to the message token's user
 *
 * jsonwebtoken and the AWS SDK come from the Lambda runtime/layer, so they are
 * faked. Run from cdk/:
 *
 *   node --test lambda/handlers/tests/publicAuth.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const OTHER_USER = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c";
const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";
const SECRET = "test-jwt-secret";
const LAMBDA_DIR = path.resolve(__dirname, "..", "..");

// Tokens are opaque ids; verify only accepts ones signed here with the right
// secret, and only when the caller pins HS256.
function fakeJwt() {
  const issued = new Map();
  let n = 0;
  return {
    issued,
    sign(payload, secret, options) {
      const token = `tok-${++n}`;
      issued.set(token, { payload: { ...payload }, secret, options });
      return token;
    },
    verify(token, secret, options) {
      const entry = issued.get(token);
      if (!entry || entry.secret !== secret) throw new Error("invalid signature");
      if (!options?.algorithms || options.algorithms.join() !== "HS256") throw new Error("algorithms must be pinned to HS256");
      return { ...entry.payload };
    },
  };
}

class FakeCommand {
  constructor(input) {
    this.input = input;
  }
}

function load(relativePath, extraFakes = {}) {
  const jwt = fakeJwt();
  const calls = { invokes: [], posts: [] };
  const fakes = {
    jsonwebtoken: jwt,
    "@aws-sdk/client-secrets-manager": {
      SecretsManagerClient: class {
        async send() {
          return { SecretString: JSON.stringify({ jwtSecret: SECRET }) };
        }
      },
      GetSecretValueCommand: FakeCommand,
    },
    "@aws-sdk/client-ssm": {
      SSMClient: class {
        async send() {
          throw new Error("no SSM in tests");
        }
      },
      GetParameterCommand: FakeCommand,
    },
    "@aws-sdk/client-lambda": {
      LambdaClient: class {
        async send(command) {
          calls.invokes.push(JSON.parse(command.input.Payload));
          return { StatusCode: 202 };
        }
      },
      InvokeCommand: FakeCommand,
    },
    "@aws-sdk/client-apigatewaymanagementapi": {
      ApiGatewayManagementApiClient: class {
        async send(command) {
          calls.posts.push(JSON.parse(command.input.Data));
        }
      },
      PostToConnectionCommand: FakeCommand,
    },
    ...extraFakes,
  };
  delete process.env.ALLOWED_ORIGIN_PARAM;
  const file = path.join(LAMBDA_DIR, relativePath);
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.dirname(file))) delete require.cache[key];
  }
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return { mod: require(file), jwt, calls };
  } finally {
    Module._load = originalLoad;
  }
}

async function quietly(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

// ---------- userAuthorizerFunction ----------

const methodArn = "arn:aws:execute-api:ca-central-1:123456789012:abc123/prod/GET/user/x";
const authorize = (mod, token) =>
  quietly(() => mod.handler({ authorizationToken: `Bearer ${token}`, methodArn }));

test("authorizer: bound access tokens expose their user id", async () => {
  const { mod, jwt } = load("authorization/userAuthorizerFunction.js");
  const policy = await authorize(mod, jwt.sign({ role: "user", typ: "access", sub: USER, jti: "j1" }, SECRET, {}));
  assert.equal(policy.principalId, USER);
  assert.deepEqual(policy.context, { userId: USER, role: "user", jti: "j1" });
  assert.equal(policy.policyDocument.Statement[0].Effect, "Allow");
});

test("authorizer: anonymous tokens carry no user id", async () => {
  const { mod, jwt } = load("authorization/userAuthorizerFunction.js");
  const policy = await authorize(mod, jwt.sign({ role: "user", jti: "j2" }, SECRET, {}));
  assert.equal(policy.context.userId, "");
});

test("authorizer: credentials and bad tokens are unauthorized", async () => {
  const { mod, jwt } = load("authorization/userAuthorizerFunction.js");
  for (const token of [
    jwt.sign({ typ: "credential", sub: USER }, SECRET, {}),
    jwt.sign({ role: "user", sub: USER }, "other-secret", {}),
    "garbage",
  ]) {
    await assert.rejects(authorize(mod, token), /Unauthorized/);
  }
});

test("authorizer: extra claims are not forwarded into the context", async () => {
  const { mod, jwt } = load("authorization/userAuthorizerFunction.js");
  const policy = await authorize(mod, jwt.sign({ role: "user", sub: USER, jti: "j", admin: true, userId: OTHER_USER }, SECRET, {}));
  assert.deepEqual(Object.keys(policy.context).sort(), ["jti", "role", "userId"]);
  assert.equal(policy.context.userId, USER);
});

// ---------- websocket/default.js ----------

const wsEvent = (message) => ({
  requestContext: { connectionId: "conn-1", domainName: "ws.example", stage: "prod", routeKey: "$default" },
  body: JSON.stringify({ action: "generate_text", query: "hello", chat_session_id: SESSION, ...message }),
});

test("websocket: text generation runs as the message token's user", async () => {
  const { mod, jwt, calls } = load("websocket/default.js");
  const token = jwt.sign({ role: "user", typ: "access", sub: USER }, SECRET, {});
  const res = await quietly(() => mod.handler(wsEvent({ token, user_id: USER })));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.invokes.length, 1);
  const payload = calls.invokes[0];
  assert.deepEqual(payload.requestContext.authorizer, { userId: USER });
  assert.equal(JSON.parse(payload.body).user_id, undefined, "client user_id is not forwarded");
});

test("websocket: missing, anonymous, credential or mismatched tokens are refused with an error event", async () => {
  const { mod, jwt, calls } = load("websocket/default.js");
  const cases = [
    [{}, 401],
    [{ token: jwt.sign({ role: "user" }, SECRET, {}) }, 401],
    [{ token: jwt.sign({ typ: "credential", sub: USER }, SECRET, {}) }, 401],
    [{ token: jwt.sign({ role: "user", sub: USER }, "other-secret", {}) }, 401],
    [{ token: jwt.sign({ role: "user", sub: USER }, SECRET, {}), user_id: OTHER_USER }, 403],
  ];
  for (const [message, status] of cases) {
    const posts = calls.posts.length;
    const res = await quietly(() => mod.handler(wsEvent(message)));
    assert.equal(res.statusCode, status, JSON.stringify(message));
    assert.equal(calls.posts.length, posts + 1, "client is told the request failed");
    assert.equal(calls.posts.at(-1).type, "error");
  }
  assert.equal(calls.invokes.length, 0);
});
