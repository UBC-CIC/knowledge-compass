/**
 * Unit tests for handlers/utils/logging.js: status-only response logs and
 * error summaries that never carry database error detail.
 *
 *   node --test cdk/lambda/handlers/tests/logging.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { logResponse, errorSummary } = require("../utils/logging.js");

const SENTINEL_EMAIL = "sentinel@example.org";

test("logResponse emits only statusCode, resource and requestId", () => {
  const lines = [];
  const saved = console.log;
  console.log = (...args) => lines.push(args);
  try {
    logResponse(
      {
        resource: "/user/{user_id}",
        path: "/user/abc",
        body: JSON.stringify({ email: SENTINEL_EMAIL }),
        headers: { Authorization: "Bearer secret" },
        requestContext: { requestId: "req-1" },
      },
      { statusCode: 200, headers: {}, body: JSON.stringify({ email: SENTINEL_EMAIL }) }
    );
  } finally {
    console.log = saved;
  }
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], [{ statusCode: 200, resource: "/user/{user_id}", requestId: "req-1" }]);
});

test("logResponse adds the keys of `extra` only when given", () => {
  const lines = [];
  const saved = console.log;
  console.log = (...args) => lines.push(args[0]);
  const event = { resource: "/admin/promote_user", requestContext: { requestId: "req-2" } };
  try {
    logResponse(event, { statusCode: 200 });
    logResponse(event, { statusCode: 200 }, { actorSub: "sub-1" });
  } finally {
    console.log = saved;
  }
  assert.ok(!("actorSub" in lines[0]));
  assert.deepEqual(lines[1], { statusCode: 200, resource: "/admin/promote_user", requestId: "req-2", actorSub: "sub-1" });
});

test("errorSummary drops message and detail from database errors", () => {
  const error = new Error(`duplicate key value violates unique constraint "users_email_key" for ${SENTINEL_EMAIL}`);
  error.name = "PostgresError";
  error.code = "23505";
  error.severity = "ERROR";
  error.detail = `Key (email)=(${SENTINEL_EMAIL}) already exists.`;
  const summary = errorSummary(error);
  assert.deepEqual(summary, { name: "PostgresError", code: "23505" });
  assert.ok(!JSON.stringify(summary).includes(SENTINEL_EMAIL));
});

test("errorSummary treats any error with a severity as a database error", () => {
  const error = new Error(`invalid input syntax for type uuid: "${SENTINEL_EMAIL}"`);
  error.severity = "ERROR";
  error.code = "22P02";
  assert.deepEqual(errorSummary(error), { name: "Error", code: "22P02" });
});

test("errorSummary keeps the message of non-database errors", () => {
  const summary = errorSummary(new Error('Unsupported route: "GET /x"'));
  assert.deepEqual(summary, { name: "Error", code: undefined, message: 'Unsupported route: "GET /x"' });
});

test("errorSummary tolerates non-error values", () => {
  assert.deepEqual(errorSummary(undefined), { name: "Error", code: undefined });
  assert.deepEqual(errorSummary("boom"), { name: "Error", code: undefined });
});
