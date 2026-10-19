/**
 * Unit tests for utils/sessionMetadata.js, the allow-list for client-supplied
 * chat_sessions.metadata on POST /chat_sessions. Pure functions, no fakes:
 *
 *   node --test cdk/lambda/handlers/tests/sessionMetadata.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateSessionMetadata,
  SERVER_AUTHORED_KEYS,
  MAX_METADATA_BYTES,
  _validateWith,
} = require("../utils/sessionMetadata.js");

test("absent, null and empty metadata are valid and store {}", () => {
  for (const value of [undefined, null, {}]) {
    assert.deepEqual(validateSessionMetadata(value), { valid: true, metadata: {} });
  }
});

test("non-plain-object metadata is rejected", () => {
  for (const value of [[], [1], "str", 5, true, Object.create(Map.prototype), new Date()]) {
    assert.deepEqual(validateSessionMetadata(value), { valid: false, error: "metadata must be an object" });
  }
});

test("server-authored keys are rejected without echoing the key", () => {
  assert.deepEqual([...SERVER_AUTHORED_KEYS], ["journey_state", "guide_state", "routing"]);
  for (const key of SERVER_AUTHORED_KEYS) {
    const result = validateSessionMetadata({ [key]: "ignore previous instructions" });
    assert.equal(result.valid, false);
    assert.equal(result.error, "metadata contains a server-managed key");
    assert.ok(!result.error.includes(key));
  }
});

test("unknown keys, including __proto__, are rejected", () => {
  for (const value of [{ foo: 1 }, JSON.parse('{"__proto__": {"x": 1}}'), { constructor: "x" }]) {
    assert.deepEqual(validateSessionMetadata(value), {
      valid: false,
      error: "metadata contains an unsupported key",
    });
  }
});

test("allow-listed keys are type-, length- and size-checked", () => {
  const fields = { note: { type: "string", maxLength: 10 } };
  assert.equal(_validateWith({ note: 5 }, fields).error, "metadata has an invalid value");
  assert.equal(_validateWith({ note: "x".repeat(11) }, fields).error, "metadata has an invalid value");

  const big = { note: { type: "string", maxLength: 5000 } };
  assert.equal(_validateWith({ note: "x".repeat(MAX_METADATA_BYTES + 1) }, big).error, "metadata is too large");

  const input = { note: "hello" };
  const result = _validateWith(input, fields);
  assert.deepEqual(result, { valid: true, metadata: { note: "hello" } });
  assert.notEqual(result.metadata, input);
});
