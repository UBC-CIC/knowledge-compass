/**
 * Unit tests for the Cognito PreSignUp trigger (authorization/preSignUp.js)
 * and the allow-list comparison it shares with POST /admin/users
 * (authorization/emailDomains.js). Fake SSM client, no AWS:
 *
 *   node --test cdk/lambda/authorization/tests/preSignUp.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const PARAM = "/test/KC/AllowedEmailDomains";

// Fresh-require the trigger with SSM returning `value` (or throwing an Error).
function loadTrigger(value) {
  const dir = path.resolve(__dirname, "..");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir) && !key.includes(`${path.sep}tests${path.sep}`)) delete require.cache[key];
  }
  class FakeCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const fakes = {
    "@aws-sdk/client-ssm": {
      SSMClient: class {
        async send(command) {
          assert.equal(command.input.Name, PARAM);
          if (value instanceof Error) throw value;
          return { Parameter: { Value: value } };
        }
      },
      GetParameterCommand: FakeCommand,
    },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(path.join(dir, "preSignUp.js"));
  } finally {
    Module._load = originalLoad;
  }
}

async function signUp(listValue, email) {
  process.env.ALLOWED_EMAIL_DOMAINS = PARAM;
  const { handler } = loadTrigger(listValue);
  const event = { request: { userAttributes: { email } } };
  const saved = console.error;
  console.error = () => {};
  try {
    return await handler(event);
  } finally {
    console.error = saved;
  }
}

test("an allowed domain passes the event through", async () => {
  const event = await signUp("example.com,other.org", "staff@other.org");
  assert.deepEqual(event, { request: { userAttributes: { email: "staff@other.org" } } });
});

test("list entries and the address are compared trimmed and lower-cased", async () => {
  await signUp(" Example.COM , other.org", "Staff@EXAMPLE.com");
});

test("other domains, subdomains, an empty list and an SSM failure are refused", async () => {
  for (const [list, email] of [
    ["example.com", "someone@elsewhere.test"],
    ["example.com", "someone@mail.example.com"],
    ["", "someone@example.com"],
    [" , ", "someone@example.com"],
    [new Error("AccessDeniedException"), "someone@example.com"],
  ]) {
    await assert.rejects(signUp(list, email), /Error validating email domain during pre-signup\./, `${list} ${email}`);
  }
});

test("isAllowedEmailDomain is the shared comparison", () => {
  const { isAllowedEmailDomain, parseAllowedDomains } = require("../emailDomains.js");
  assert.deepEqual(parseAllowedDomains(" A.org ,, b.ORG ,"), ["a.org", "b.org"]);
  assert.equal(isAllowedEmailDomain("x@b.org", parseAllowedDomains("a.org,b.org")), true);
  assert.equal(isAllowedEmailDomain("x@B.Org", parseAllowedDomains("a.org,b.org")), true);
  assert.equal(isAllowedEmailDomain("x@sub.b.org", parseAllowedDomains("b.org")), false);
  assert.equal(isAllowedEmailDomain("no-at-sign", parseAllowedDomains("b.org")), false);
  assert.equal(isAllowedEmailDomain("x@b.org", []), false);
  assert.equal(isAllowedEmailDomain(undefined, parseAllowedDomains("b.org")), false);
});
