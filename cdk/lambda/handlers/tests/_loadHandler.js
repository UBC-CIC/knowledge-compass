/**
 * Test helper: loads a handler module with its runtime-only dependencies
 * (postgres, AWS SDK clients) replaced by in-process fakes. Those packages are
 * provided by the Lambda layer in AWS and are not installed locally, so the
 * handler tests need no database, network, or node_modules.
 */

const Module = require("node:module");
const path = require("node:path");

// Minimal stand-in for the postgres.js tagged-template client. `respond` maps
// the joined SQL text + values to the rows a query returns.
function fakeSql(respond = () => []) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (text === "SELECT 1") return Promise.resolve([{ "?column?": 1 }]);
    try {
      return Promise.resolve(respond(text, values));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  sql.calls = calls;
  // Queries other than the connection check, for assertions.
  sql.queries = () => calls.filter((c) => c.text !== "SELECT 1");
  return sql;
}

function stubs(sql) {
  class FakeCommand {
    constructor(input) {
      this.input = input;
    }
  }
  return {
    postgres: () => sql,
    "@aws-sdk/client-secrets-manager": {
      SecretsManagerClient: class {
        async send() {
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
    jsonwebtoken: {
      sign: (payload, secret, options) => `signed:${JSON.stringify({ payload, secret, options })}`,
    },
    "@aws-sdk/client-ssm": {
      SSMClient: class {
        async send() {
          throw new Error("SSM is not available in unit tests");
        }
      },
      GetParameterCommand: FakeCommand,
    },
  };
}

/**
 * Fresh-require `handlers/<name>.js` (and its utils) wired to `sql`.
 * ALLOWED_ORIGIN_PARAM is unset so CORS resolves to "*" without SSM.
 */
function loadHandler(name, sql) {
  delete process.env.ALLOWED_ORIGIN_PARAM;
  const handlersDir = path.resolve(__dirname, "..");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(handlersDir) && !key.includes(`${path.sep}tests${path.sep}`)) {
      delete require.cache[key];
    }
  }

  const fakes = stubs(sql);
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

// Silence handler console output (it logs full responses) during a test.
async function quietly(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

module.exports = { fakeSql, loadHandler, quietly };
