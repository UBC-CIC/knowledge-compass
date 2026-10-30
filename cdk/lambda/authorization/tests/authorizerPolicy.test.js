/**
 * Unit tests for the policies the two REST authorizers return
 * (userAuthorizerFunction.js, adminAuthorizerFunction.js). The policy is
 * cached per token and reused across routes, so it is evaluated here against
 * several methodArns the way API Gateway does: `*` matches any characters
 * (including "/") and an explicit Deny beats an Allow. No AWS:
 *
 *   node --test cdk/lambda/authorization/tests/authorizerPolicy.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const STAGE = "arn:aws:execute-api:ca-central-1:123456789012:abc123/prod";
const arn = (method, resource) => `${STAGE}/${method}${resource}`;
const SECRET = "test-jwt-secret";

// Tokens are "signed:<json>"; verify() checks the secret like jsonwebtoken.
const fakeJwt = {
  verify: (token, secret) => {
    const { payload, secret: signedWith } = JSON.parse(token.slice("signed:".length));
    if (signedWith !== secret) throw new Error("invalid signature");
    return payload;
  },
};
const token = (payload) => `Bearer signed:${JSON.stringify({ payload, secret: SECRET })}`;

function load(file, fakes) {
  const full = path.resolve(__dirname, "..", "..", file);
  delete require.cache[full];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(full);
  } finally {
    Module._load = originalLoad;
  }
}

const secretsManager = (secretString) => ({
  SecretsManagerClient: class {
    async send() {
      return { SecretString: secretString };
    }
  },
  GetSecretValueCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
});

function allows(policy, methodArn) {
  const matches = (pattern) =>
    new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.?+^$()[\]{}|\\]/g, "\\$&")).join(".*")}$`).test(methodArn);
  const hits = policy.policyDocument.Statement.filter((s) => [].concat(s.Resource).some(matches));
  return hits.some((s) => s.Effect === "Allow") && !hits.some((s) => s.Effect === "Deny");
}

const GUEST_ROUTES = [
  arn("GET", "/user/2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"),
  arn("POST", "/chat_sessions"),
  arn("PUT", "/chat_sessions/5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99/feedback"),
  arn("GET", "/system-settings/service-status"),
];
const ADMIN_ROUTES = [
  arn("GET", "/admin/users"),
  arn("POST", "/admin/embedding-spaces/5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99/purge"),
  arn("DELETE", "/admin/data_sources/5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99"),
];

function loadUserAuthorizer(secret = { jwtSecret: SECRET }) {
  process.env.JWT_ISSUER = "test-issuer";
  process.env.JWT_SECRET = "jwt-secret-arn";
  return load("authorization/userAuthorizerFunction.js", {
    "@aws-sdk/client-secrets-manager": secretsManager(JSON.stringify(secret)),
    jsonwebtoken: fakeJwt,
  });
}

const ACCESS = { typ: "access", iss: "test-issuer", aud: "kc-public-api", jti: "6f1c2a9e-0d3b-4c5a-8e7f-1a2b3c4d5e6f" };

test("guest policy allows guest routes and denies every admin route", async () => {
  const { handler } = loadUserAuthorizer();
  const policy = await handler({ authorizationToken: token(ACCESS), methodArn: GUEST_ROUTES[0] });
  for (const route of GUEST_ROUTES) assert.ok(allows(policy, route), route);
  for (const route of ADMIN_ROUTES) assert.ok(!allows(policy, route), route);
});

test("guest policy does not reach another stage", async () => {
  const { handler } = loadUserAuthorizer();
  const policy = await handler({ authorizationToken: token(ACCESS), methodArn: GUEST_ROUTES[0] });
  assert.ok(!allows(policy, GUEST_ROUTES[1].replace("/prod/", "/prod2/")));
});

test("a role claim in a guest token never yields admin context", async () => {
  const { handler } = loadUserAuthorizer();
  const policy = await handler({
    authorizationToken: token({ ...ACCESS, sub: "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11", role: "admin" }),
    methodArn: GUEST_ROUTES[0],
  });
  assert.equal(policy.context.role, "user");
});

test("after a JWT secret rotation, tokens signed with the previous key still authorize", async () => {
  const { handler } = loadUserAuthorizer({ jwtSecret: "rotated-secret", previousJwtSecret: SECRET });
  const policy = await handler({ authorizationToken: token(ACCESS), methodArn: GUEST_ROUTES[0] });
  assert.ok(allows(policy, GUEST_ROUTES[0]));

  const retired = `Bearer signed:${JSON.stringify({ payload: ACCESS, secret: "retired-secret" })}`;
  const saved = console.error;
  console.error = () => {};
  try {
    await assert.rejects(handler({ authorizationToken: retired, methodArn: GUEST_ROUTES[0] }), /Unauthorized/);
  } finally {
    console.error = saved;
  }
});

function loadAdminAuthorizer(groups = ["admin"]) {
  process.env.SM_COGNITO_CREDENTIALS = "cognito-secret-arn";
  return load("adminAuthorizerFunction/adminAuthorizerFunction.js", {
    "@aws-sdk/client-secrets-manager": secretsManager(
      JSON.stringify({ VITE_COGNITO_USER_POOL_ID: "pool", VITE_COGNITO_USER_POOL_CLIENT_ID: "client" })
    ),
    "aws-jwt-verify": {
      CognitoJwtVerifier: {
        create: () => ({ verify: async () => ({ sub: "admin-sub", email: "a@example.org", "cognito:groups": groups }) }),
      },
    },
  });
}

test("admin policy covers admin routes on this stage only", async () => {
  const { handler } = loadAdminAuthorizer();
  const policy = await handler({ authorizationToken: "Bearer id-token", methodArn: ADMIN_ROUTES[0] });
  for (const route of ADMIN_ROUTES) assert.ok(allows(policy, route), route);
  for (const route of GUEST_ROUTES) assert.ok(!allows(policy, route), route);
  // The old `apiId/prod*` resource also matched stages named prod-*, prod2, ...
  assert.ok(!allows(policy, ADMIN_ROUTES[0].replace("/prod/", "/prod2/")));
});

test("non-admin Cognito users are rejected", async () => {
  const { handler } = loadAdminAuthorizer(["staff"]);
  const saved = { warn: console.warn, error: console.error };
  console.warn = console.error = () => {};
  try {
    await assert.rejects(handler({ authorizationToken: "Bearer id-token", methodArn: ADMIN_ROUTES[0] }), /Unauthorized/);
  } finally {
    Object.assign(console, saved);
  }
});
