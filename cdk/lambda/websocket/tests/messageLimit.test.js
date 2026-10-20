/**
 * Unit tests for websocket/messageLimit.js: the frame cap is the live
 * system_settings value, and a missed read stays at the conservative default
 * (or the last good value) instead of a higher stand-in.
 *
 *   node --test cdk/lambda/websocket/tests/messageLimit.test.js
 */

const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

function loadMessageLimit({ state = {} } = {}) {
  const queries = [];
  let postgresCalls = 0;
  let lastConfig = null;
  class FakeCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const fakes = {
    postgres: (config) => {
      postgresCalls += 1;
      lastConfig = config;
      const sql = (strings) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        queries.push(text);
        if (text === "SELECT 1") {
          return state.connectError ? Promise.reject(state.connectError) : Promise.resolve([{ "?column?": 1 }]);
        }
        if (state.queryError) return Promise.reject(state.queryError);
        return Promise.resolve(state.rows ?? []);
      };
      sql.end = async () => {
        state.ended = (state.ended || 0) + 1;
      };
      return sql;
    },
    "@aws-sdk/client-secrets-manager": {
      SecretsManagerClient: class {
        async send(command) {
          if (state.secretError) throw state.secretError;
          assert.equal(command.input.SecretId, process.env.SM_DB_CREDENTIALS);
          return {
            SecretString: JSON.stringify({ username: "u", password: "p", dbname: "KC", port: 5432 }),
          };
        }
      },
      GetSecretValueCommand: FakeCommand,
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
    const mod = require(path.join(dir, "messageLimit.js"));
    return {
      mod,
      queries,
      postgresCalls: () => postgresCalls,
      lastConfig: () => lastConfig,
    };
  } finally {
    Module._load = originalLoad;
  }
}

function withDbEnv() {
  const keys = ["SM_DB_CREDENTIALS", "RDS_PROXY_ENDPOINT"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SM_DB_CREDENTIALS = "db-secret";
  process.env.RDS_PROXY_ENDPOINT = "proxy.example";
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
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

const capQueries = (queries) => queries.filter((text) => text.includes("system_settings"));

test("a missed configuration uses 2000 and does not query", async () => {
  const restore = withDbEnv();
  delete process.env.SM_DB_CREDENTIALS;
  delete process.env.RDS_PROXY_ENDPOINT;
  try {
    const { mod, postgresCalls } = loadMessageLimit();
    const value = await quietly(() => mod.getMaxCharactersPerUserMessage());
    assert.equal(value, 2000);
    assert.equal(postgresCalls(), 0);
  } finally {
    restore();
  }
});

test("the stored cap is returned and reused until the TTL, then refreshed", async () => {
  const restore = withDbEnv();
  const state = { rows: [{ max_characters_per_user_message: 750 }] };
  try {
    const { mod, queries, postgresCalls, lastConfig } = loadMessageLimit({ state });
    assert.equal(await mod.getMaxCharactersPerUserMessage(1_000), 750);
    assert.equal(postgresCalls(), 1);
    assert.equal(lastConfig().host, "proxy.example");
    assert.equal(lastConfig().ssl.rejectUnauthorized, true);
    assert.equal(capQueries(queries).length, 1);

    state.rows = [{ max_characters_per_user_message: 50 }];
    assert.equal(await mod.getMaxCharactersPerUserMessage(1_000 + mod.CACHE_TTL_MS - 1), 750);
    assert.equal(capQueries(queries).length, 1);

    assert.equal(await mod.getMaxCharactersPerUserMessage(1_000 + mod.CACHE_TTL_MS), 50);
    assert.equal(capQueries(queries).length, 2);
    assert.equal(postgresCalls(), 1, "the database connection is reused");
  } finally {
    restore();
  }
});

test("a numeric string is accepted; an empty, zero, or out-of-range row is the default", async () => {
  const restore = withDbEnv();
  try {
    for (const [value, expected] of [
      ["4000", 4000],
      [200000, 200000],
      [undefined, 2000],
      [0, 2000],
      [200001, 2000],
      [1.5, 2000],
      [-5, 2000],
    ]) {
      const state = { rows: value === undefined ? [] : [{ max_characters_per_user_message: value }] };
      const { mod } = loadMessageLimit({ state });
      assert.equal(await quietly(() => mod.getMaxCharactersPerUserMessage(0)), expected, String(value));
    }
  } finally {
    restore();
  }
});

test("a failed refresh keeps the last good cap and backs off before retrying", async () => {
  const restore = withDbEnv();
  const state = { rows: [{ max_characters_per_user_message: 400 }] };
  try {
    const { mod, queries } = loadMessageLimit({ state });
    assert.equal(await mod.getMaxCharactersPerUserMessage(0), 400);

    state.queryError = Object.assign(new Error("db down"), { name: "QueryError" });
    const duringOutage = await quietly(() => mod.getMaxCharactersPerUserMessage(mod.CACHE_TTL_MS));
    assert.equal(duringOutage, 400);
    const afterFailure = capQueries(queries).length;

    const backedOff = await mod.getMaxCharactersPerUserMessage(mod.CACHE_TTL_MS + mod.FAILURE_BACKOFF_MS - 1);
    assert.equal(backedOff, 400);
    assert.equal(capQueries(queries).length, afterFailure, "a down database is not hit on every frame");

    state.queryError = null;
    state.rows = [{ max_characters_per_user_message: 900 }];
    assert.equal(await mod.getMaxCharactersPerUserMessage(mod.CACHE_TTL_MS + mod.FAILURE_BACKOFF_MS), 900);
  } finally {
    restore();
  }
});

test("a secret or connection failure uses 2000, and a later success is picked up", async () => {
  const restore = withDbEnv();
  const state = { secretError: Object.assign(new Error("sm down"), { name: "SecretsError" }) };
  try {
    const { mod, postgresCalls } = loadMessageLimit({ state });
    assert.equal(await quietly(() => mod.getMaxCharactersPerUserMessage(0)), 2000);
    assert.equal(postgresCalls(), 0);

    state.secretError = null;
    state.connectError = Object.assign(new Error("timeout"), { name: "ConnectError" });
    assert.equal(await quietly(() => mod.getMaxCharactersPerUserMessage(mod.FAILURE_BACKOFF_MS)), 2000);
    assert.equal(state.ended, 1, "a failed client is closed");

    state.connectError = null;
    state.rows = [{ max_characters_per_user_message: 640 }];
    assert.equal(await mod.getMaxCharactersPerUserMessage(mod.FAILURE_BACKOFF_MS * 2), 640);
  } finally {
    restore();
  }
});
