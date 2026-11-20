/**
 * Test helper: loads a handler module with its runtime-only dependencies
 * (postgres, AWS SDK clients) replaced by in-process fakes. Those packages are
 * provided by the Lambda layer in AWS and are not installed locally, so the
 * handler tests need no database, network, or node_modules.
 */

const Module = require("node:module");
const path = require("node:path");

// Every minted token carries iss (userCredential.js fails closed without it).
// Tests that check the unset case delete it and restore it themselves.
if (!process.env.JWT_ISSUER) process.env.JWT_ISSUER = "test-issuer";

// Minimal stand-in for the postgres.js tagged-template client. `respond` maps
// the joined SQL text + values to the rows a query returns. With
// `rejectUndefined`, a query that binds `undefined` rejects the way postgres.js
// does when no `transform.undefined` is configured (as in the Lambda handlers).
function fakeSql(respond = () => [], { rejectUndefined = false } = {}) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (text === "SELECT 1") return Promise.resolve([{ "?column?": 1 }]);
    if (rejectUndefined && values.some((v) => v === undefined)) {
      const error = new Error("Undefined values are not allowed");
      error.code = "UNDEFINED_VALUE";
      return Promise.reject(error);
    }
    try {
      return Promise.resolve(respond(text, values));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  sql.calls = calls;
  // Transactions run on the same fake; tests may override this.
  sql.begin = async (fn) => fn(sql);
  // Queries other than the connection check, for assertions.
  sql.queries = () => calls.filter((c) => c.text !== "SELECT 1");
  return sql;
}

// Readable stand-in for jsonwebtoken: tokens are "signed:<json>" so tests can
// inspect what was signed and forge tokens (see fakeToken). Like the real
// library, sign() adds iat and verify() checks the secret.
const fakeJwt = {
  sign: (payload, secret, options) =>
    `signed:${JSON.stringify({
      payload: { iat: Math.floor(Date.now() / 1000), ...payload },
      secret,
      options,
    })}`,
  verify: (token, secret, options) => {
    if (typeof token !== "string" || !token.startsWith("signed:")) throw new Error("jwt malformed");
    const { payload, secret: signedWith } = JSON.parse(token.slice("signed:".length));
    if (signedWith !== secret) throw new Error("invalid signature");
    if (!options?.algorithms || options.algorithms.join() !== "HS256") {
      throw new Error("algorithms must be pinned to HS256");
    }
    return payload;
  },
};

/** A token the fake verifies, as if signed with `secret`. */
const fakeToken = (payload, secret = "test-jwt-secret") =>
  `signed:${JSON.stringify({ payload, secret, options: {} })}`;

/** Claims of a fake-signed token. */
const decodeFakeToken = (token) => JSON.parse(token.slice("signed:".length));

// The CORS allow-list every loaded handler reads. Tests that need a
// cross-origin response send `Origin: TEST_ALLOWED_ORIGIN`.
const TEST_ALLOWED_ORIGINS_PARAM = "/test/API/AllowedOrigins";
const TEST_ALLOWED_ORIGIN = "https://app.example.test";

function stubs(sql, secrets = {}, ssmParameters = {}, cognito = () => ({})) {
  ssmParameters = { [TEST_ALLOWED_ORIGINS_PARAM]: TEST_ALLOWED_ORIGIN, ...ssmParameters };
  class FakeCommand {
    constructor(input) {
      this.input = input;
    }
  }
  // Each Cognito command class is named so `cognito(name, input)` can tell
  // them apart; it returns the response or throws, as the SDK would.
  const cognitoCommand = (name) =>
    class extends FakeCommand {
      get commandName() {
        return name;
      }
    };
  return {
    "@aws-sdk/client-cognito-identity-provider": {
      CognitoIdentityProviderClient: class {
        async send(command) {
          return cognito(command.commandName, command.input);
        }
      },
      AdminCreateUserCommand: cognitoCommand("AdminCreateUser"),
      AdminGetUserCommand: cognitoCommand("AdminGetUser"),
      AdminAddUserToGroupCommand: cognitoCommand("AdminAddUserToGroup"),
    },
    // Records the connection config so tests can assert on it (e.g. TLS).
    postgres: (config) => {
      sql.connectionConfig = config;
      return sql;
    },
    "@aws-sdk/client-secrets-manager": {
      SecretsManagerClient: class {
        async send(command) {
          // Per-secret overrides (options.secrets): a string is the
          // SecretString, an Error is thrown as a failed fetch.
          const secretId = command?.input?.SecretId;
          if (secretId && Object.prototype.hasOwnProperty.call(secrets, secretId)) {
            const value = secrets[secretId];
            if (value instanceof Error) throw value;
            return { SecretString: value };
          }
          return {
            SecretString: JSON.stringify({
              port: 5432, username: "test", password: "test", dbname: "test", jwtSecret: "test-jwt-secret",
            }),
          };
        }
      },
      GetSecretValueCommand: FakeCommand,
    },
    // jsonwebtoken comes from the Lambda layer; a readable fake lets tests
    // assert what was signed.
    jsonwebtoken: fakeJwt,
    "@aws-sdk/client-ssm": {
      SSMClient: class {
        async send(command) {
          // Per-parameter overrides (options.ssmParameters): a string is the
          // Value, an Error is thrown as a failed fetch.
          const name = command?.input?.Name;
          if (name && Object.prototype.hasOwnProperty.call(ssmParameters, name)) {
            const value = ssmParameters[name];
            if (value instanceof Error) throw value;
            return { Parameter: { Value: value } };
          }
          throw new Error("SSM is not available in unit tests");
        }
      },
      GetParameterCommand: FakeCommand,
    },
  };
}

/**
 * Fresh-require `handlers/<name>.js` (and its utils) wired to `sql`.
 * ALLOWED_ORIGIN_PARAM points at a fake parameter allowing TEST_ALLOWED_ORIGIN.
 * options.secrets maps a Secrets Manager SecretId to its SecretString (or an
 * Error to throw); other ids return the default DB credentials.
 * options.ssmParameters maps an SSM parameter Name to its Value (or an Error
 * to throw); other names throw.
 * options.cognito is `(commandName, input) => response` for the Cognito
 * identity provider client (e.g. "AdminCreateUser"); it may throw.
 */
function loadHandler(name, sql, options = {}) {
  process.env.ALLOWED_ORIGIN_PARAM = TEST_ALLOWED_ORIGINS_PARAM;
  const handlersDir = path.resolve(__dirname, "..");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(handlersDir) && !key.includes(`${path.sep}tests${path.sep}`)) {
      delete require.cache[key];
    }
  }

  const fakes = stubs(sql, options.secrets, options.ssmParameters, options.cognito);
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(path.join(handlersDir, `${name}.js`));
  } finally {
    Module._load = originalLoad;
  }
}

// Silence handler console output (it logs status lines and errors) during a test.
async function quietly(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

module.exports = {
  fakeSql, loadHandler, quietly, fakeToken, decodeFakeToken, TEST_ALLOWED_ORIGINS_PARAM, TEST_ALLOWED_ORIGIN,
};
