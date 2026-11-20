/**
 * Unit tests for handlers/utils/cors.js: every misconfiguration or SSM failure
 * must fail closed (no Access-Control-Allow-Origin), never to a wildcard.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

const CORS_PATH = path.resolve(__dirname, "../utils/cors.js");
const PARAM = "/test/API/AllowedOrigins";
const APP = "https://app.example.test";

// Fresh-require cors.js with a fake SSM whose GetParameter runs `fetch(name)`.
function loadCors(fetch) {
  delete require.cache[CORS_PATH];
  const calls = [];
  const fake = {
    SSMClient: class {
      async send(command) {
        calls.push(command.input.Name);
        return { Parameter: { Value: await fetch(command.input.Name) } };
      }
    },
    GetParameterCommand: class {
      constructor(input) { this.input = input; }
    },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    return request === "@aws-sdk/client-ssm" ? fake : originalLoad.call(this, request, ...rest);
  };
  try {
    return { ...require(CORS_PATH), calls };
  } finally {
    Module._load = originalLoad;
  }
}

const withOrigin = (origin) => ({ headers: { origin } });

async function quietly(fn) {
  const saved = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = saved; }
}

test.afterEach(() => { delete process.env.ALLOWED_ORIGIN_PARAM; });

test("unset ALLOWED_ORIGIN_PARAM fails closed instead of allowing *", async () => {
  delete process.env.ALLOWED_ORIGIN_PARAM;
  const { getCorsHeaders } = loadCors(() => APP);
  const headers = await quietly(() => getCorsHeaders(withOrigin("https://evil.example"), "GET"));
  assert.equal(headers["Access-Control-Allow-Origin"], undefined);
});

test("an SSM failure fails closed and is not cached", async () => {
  process.env.ALLOWED_ORIGIN_PARAM = PARAM;
  let fail = true;
  const { getCorsHeaders, calls } = loadCors(() => {
    if (fail) throw new Error("ThrottlingException");
    return APP;
  });
  const first = await quietly(() => getCorsHeaders(withOrigin(APP), "GET"));
  assert.equal(first["Access-Control-Allow-Origin"], undefined);

  fail = false;
  const second = await getCorsHeaders(withOrigin(APP), "GET");
  assert.equal(second["Access-Control-Allow-Origin"], APP, "recovers once SSM does");
  assert.equal(calls.length, 2);
});

test("a * entry in the parameter is ignored; listed origins are echoed", async () => {
  process.env.ALLOWED_ORIGIN_PARAM = PARAM;
  const { getCorsHeaders } = loadCors(() => `*, ${APP}/ , https://*.example.test`);
  const foreign = await getCorsHeaders(withOrigin("https://evil.example"), "GET");
  assert.equal(foreign["Access-Control-Allow-Origin"], undefined);
  const allowed = await getCorsHeaders({ headers: { Origin: APP } }, "GET");
  assert.equal(allowed["Access-Control-Allow-Origin"], APP);
  assert.equal(allowed.Vary, "Origin");
});

test("Allow-Methods lists only the served methods plus OPTIONS", async () => {
  process.env.ALLOWED_ORIGIN_PARAM = PARAM;
  const { getCorsHeaders } = loadCors(() => APP);
  assert.equal((await getCorsHeaders(withOrigin(APP), "GET,POST"))["Access-Control-Allow-Methods"], "GET,POST,OPTIONS");
  assert.equal((await getCorsHeaders(withOrigin(APP)))["Access-Control-Allow-Methods"], "OPTIONS");
});
