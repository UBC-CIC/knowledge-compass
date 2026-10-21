/**
 * Gateway CORS origin selection: one concrete SPA origin, never a wildcard.
 *
 *   node --test cdk/lambda/gatewayCorsOrigin/tests/origin.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { gatewayAllowOrigin } = require("../origin");

test("uses the first origin and strips a trailing slash", () => {
  assert.equal(
    gatewayAllowOrigin("https://main.abc123.amplifyapp.com/, https://extra.example"),
    "https://main.abc123.amplifyapp.com",
  );
  assert.equal(gatewayAllowOrigin("http://localhost:5173/"), "http://localhost:5173");
});

test("refuses a wildcard, an empty list, and a path", () => {
  for (const raw of ["*", " * ", "", " ,https://example.com", "https://*", "https://example.com/app"]) {
    assert.throws(() => gatewayAllowOrigin(raw), /wildcard|empty|single http/);
  }
});
