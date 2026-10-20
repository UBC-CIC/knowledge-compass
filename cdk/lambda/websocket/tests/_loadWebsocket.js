/**
 * Test helper: loads websocket handlers with jsonwebtoken and the AWS SDK
 * clients (provided by the Lambda runtime/layer, not installed locally)
 * replaced by in-process fakes. Every non-test module in this directory is
 * evicted first, because accessToken.js and connections.js build their clients
 * and secret cache at module scope.
 */

const Module = require("node:module");
const path = require("node:path");

const SECRET = "test-jwt-secret";
const ISSUER = "test-issuer";
const USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";

class FakeCommand {
  constructor(input) {
    this.input = input;
  }
}

// Tokens are "signed:<base64url json>" (no commas or spaces, like a real JWT,
// so they fit in a Sec-WebSocket-Protocol list); verify() checks the secret,
// the pinned algorithm and expiry like the real library.
const fakeJwt = {
  verify: (token, secret, options) => {
    if (typeof token !== "string" || !token.startsWith("signed:")) throw new Error("jwt malformed");
    const { payload, secret: signedWith } = JSON.parse(
      Buffer.from(token.slice("signed:".length), "base64url").toString("utf8")
    );
    if (signedWith !== secret) throw new Error("invalid signature");
    if (!options?.algorithms || options.algorithms.join() !== "HS256") {
      throw new Error("algorithms must be pinned to HS256");
    }
    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
      throw Object.assign(new Error("jwt expired"), { name: "TokenExpiredError" });
    }
    return payload;
  },
};

/** A valid user-bound access token; override or delete (undefined) claims. */
function accessToken(claims = {}, secret = SECRET) {
  const payload = { role: "user", typ: "access", sub: USER, iss: ISSUER, aud: "kc-public-api", ...claims };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
  return `signed:${Buffer.from(JSON.stringify({ payload, secret })).toString("base64url")}`;
}

/**
 * Fake @aws-sdk/client-dynamodb. `connections` is a Map<connectionId, userId>
 * (read, written and deleted) or an Error that every send throws. Every
 * command input is pushed to `calls` as { name, input }.
 */
function dynamoFake(connections, calls = []) {
  class GetItemCommand extends FakeCommand {}
  class PutItemCommand extends FakeCommand {}
  class DeleteItemCommand extends FakeCommand {}
  return {
    DynamoDBClient: class {
      async send(command) {
        calls.push({ name: command.constructor.name, input: command.input });
        if (connections instanceof Error) throw connections;
        const id = command.input.Key?.connectionId?.S ?? command.input.Item?.connectionId?.S;
        if (command instanceof GetItemCommand) {
          return connections.has(id)
            ? { Item: { connectionId: { S: id }, userId: { S: connections.get(id) } } }
            : {};
        }
        if (command instanceof PutItemCommand) {
          if (command.input.ConditionExpression === "attribute_not_exists(connectionId)" && connections.has(id)) {
            throw Object.assign(new Error("conditional check failed"), { name: "ConditionalCheckFailedException" });
          }
          connections.set(id, command.input.Item.userId.S);
          return {};
        }
        if (command instanceof DeleteItemCommand) {
          connections.delete(id);
          return {};
        }
        throw new Error(`unexpected command ${command.constructor.name}`);
      }
    },
    GetItemCommand,
    PutItemCommand,
    DeleteItemCommand,
  };
}

/**
 * Fresh-require websocket/<name>.js. Options:
 *   connections - Map<connectionId, userId> or Error (see dynamoFake)
 *   secretError - Error thrown by Secrets Manager
 * Returns { handler, module, invocations, posts, deletes, dynamoCalls, connections }.
 */
function load(name, { connections = new Map(), secretError } = {}) {
  const invocations = [];
  const posts = [];
  const deletes = [];
  const dynamoCalls = [];
  class PostToConnectionCommand extends FakeCommand {}
  class DeleteConnectionCommand extends FakeCommand {}
  const fakes = {
    jsonwebtoken: fakeJwt,
    "@aws-sdk/client-secrets-manager": {
      SecretsManagerClient: class {
        async send() {
          if (secretError) throw secretError;
          return { SecretString: JSON.stringify({ jwtSecret: SECRET }) };
        }
      },
      GetSecretValueCommand: FakeCommand,
    },
    "@aws-sdk/client-lambda": {
      LambdaClient: class {
        async send(command) {
          invocations.push(command.input);
          return { StatusCode: 202 };
        }
      },
      InvokeCommand: FakeCommand,
    },
    "@aws-sdk/client-apigatewaymanagementapi": {
      ApiGatewayManagementApiClient: class {
        async send(command) {
          if (command instanceof DeleteConnectionCommand) deletes.push(command.input);
          else posts.push(command.input);
        }
      },
      PostToConnectionCommand,
      DeleteConnectionCommand,
    },
    "@aws-sdk/client-dynamodb": dynamoFake(connections, dynamoCalls),
    // messageLimit.js requires postgres at load time. Default-route tests never
    // configure the database, so a call here is a test bug.
    postgres: () => {
      const sql = () => Promise.reject(new Error("unexpected database call"));
      sql.end = async () => {};
      return sql;
    },
  };

  const dir = path.resolve(__dirname, "..");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir + path.sep) && !key.includes(`${path.sep}tests${path.sep}`)) delete require.cache[key];
  }
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const mod = require(path.join(dir, `${name}.js`));
    return { handler: mod.handler, module: mod, invocations, posts, deletes, dynamoCalls, connections };
  } finally {
    Module._load = originalLoad;
  }
}

const loadDefault = (options) => load("default", options);
const loadConnect = (options) => load("connect", options);
const loadDisconnect = (options) => load("disconnect", options);

/** Set JWT_ISSUER and CONNECTIONS_TABLE_NAME for a test; returns a restore function. */
function withEnv(overrides = {}) {
  const values = { JWT_ISSUER: ISSUER, CONNECTIONS_TABLE_NAME: "test-connections", ...overrides };
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// Run fn with console output captured instead of printed: { result, output }.
async function captureConsole(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const output = [];
  console.log = console.error = console.warn = (...args) => {
    output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    return { result: await fn(), output };
  } finally {
    Object.assign(console, saved);
  }
}

// Silence handler console output during a test.
async function quietly(fn) {
  return (await captureConsole(fn)).result;
}

module.exports = {
  SECRET,
  ISSUER,
  USER,
  fakeJwt,
  accessToken,
  dynamoFake,
  load,
  loadDefault,
  loadConnect,
  loadDisconnect,
  withEnv,
  quietly,
  captureConsole,
};
