/**
 * Unit tests for the evaluation-harness session tag (utils/evalTag.js) and its
 * use on POST /chat_sessions. Fake SQL and Secrets Manager, no network:
 *
 *   node --test cdk/lambda/handlers/tests/evalTag.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler } = require("./_loadHandler.js");

const USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const OTHER_USER = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c";
const SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99";
const SECRET_NAME = "KC/eval/signing-secret";
const KEY = "k".repeat(48);

const now = () => Math.floor(Date.now() / 1000);

// Loaded once for the pure helpers; the handler tests reload per case.
const evalTag = loadHandler("utils/evalTag", fakeSql());

const tagFor = (userId, overrides = {}, key = KEY) => {
  const fields = { run_id: "run_2026-10-14", mode: "guideline", exp: now() + 3600, ...overrides };
  const sig = overrides.sig ?? evalTag.sign(key, userId, fields.run_id, fields.mode, fields.exp);
  return { ...fields, sig };
};

// Runs fn with console captured; returns [result, joined log text].
async function captured(fn) {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const sink = (...args) => lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  console.log = console.error = console.warn = sink;
  try {
    return [await fn(), lines.join("\n")];
  } finally {
    Object.assign(console, saved);
  }
}

function createSql() {
  return fakeSql((text) => {
    if (text.startsWith("SELECT id FROM users")) return [{ id: USER }];
    if (text.startsWith("INSERT INTO chat_sessions")) return [{ id: SESSION, user_id: USER, metadata: {} }];
    return [];
  });
}

async function createSession(body, { secrets = { [SECRET_NAME]: JSON.stringify({ signingKey: KEY }) }, env = true } = {}) {
  if (env) process.env.EVAL_SIGNING_SECRET_NAME = SECRET_NAME;
  else delete process.env.EVAL_SIGNING_SECRET_NAME;
  const sql = createSql();
  const { handler } = loadHandler("chatSessionHandler", sql, { secrets });
  try {
    const [res, logs] = await captured(() =>
      handler({
        httpMethod: "POST",
        resource: "/chat_sessions",
        requestContext: { authorizer: { userId: USER, role: "user", jti: "j" } },
        body: JSON.stringify(body),
      }),
    );
    const insert = sql.queries().find((q) => q.text.startsWith("INSERT INTO chat_sessions"));
    return { res, logs, insert };
  } finally {
    delete process.env.EVAL_SIGNING_SECRET_NAME;
  }
}

const tagged = (insert) => insert.text.includes("eval_run_id");

// ── Pure verification ────────────────────────────────────────────────────

// Shared with evals/tests/test_signing.py so the Python signer and this
// verifier cannot drift apart.
test("signature matches the cross-language test vector", () => {
  assert.equal(
    evalTag.sign("k".repeat(48), USER, "run_1", "guideline", 1900000000),
    "92d282dcea2752c83ef6873359c98561a7136b0963661791ef94ecf70810379d",
  );
});

test("a correctly signed tag verifies", () => {
  const tag = tagFor(USER);
  assert.deepEqual(evalTag.verifyEvalTag(tag, USER, KEY), { runId: tag.run_id, mode: "guideline" });
});

test("tags are bound to the signing user", () => {
  assert.equal(evalTag.verifyEvalTag(tagFor(OTHER_USER), USER, KEY), null);
});

test("expired and too-far-ahead tags are rejected", () => {
  assert.equal(evalTag.verifyEvalTag(tagFor(USER, { exp: now() - 1 }), USER, KEY), null);
  assert.equal(evalTag.verifyEvalTag(tagFor(USER, { exp: now() + evalTag.MAX_TAG_LIFETIME_SECONDS + 60 }), USER, KEY), null);
  assert.equal(evalTag.verifyEvalTag(tagFor(USER, { exp: String(now() + 60) }), USER, KEY), null);
});

test("tampered fields fail the signature", () => {
  const tag = tagFor(USER);
  assert.equal(evalTag.verifyEvalTag({ ...tag, mode: "standard" }, USER, KEY), null);
  assert.equal(evalTag.verifyEvalTag({ ...tag, run_id: "other_run" }, USER, KEY), null);
  assert.equal(evalTag.verifyEvalTag({ ...tag, exp: tag.exp + 1 }, USER, KEY), null);
  assert.equal(evalTag.verifyEvalTag(tag, USER, "x".repeat(48)), null);
});

test("malformed fields are rejected before any HMAC work", () => {
  for (const bad of [
    { run_id: "has space" },
    { run_id: "" },
    { run_id: "a".repeat(65) },
    { run_id: "semi;colon" },
    { mode: "admin" },
    { sig: "zz" },
    { sig: "A".repeat(64) },
  ]) {
    assert.equal(evalTag.verifyEvalTag(tagFor(USER, bad), USER, KEY), null, JSON.stringify(bad));
  }
  for (const notATag of [null, undefined, "tag", 7, [tagFor(USER)]]) {
    assert.equal(evalTag.verifyEvalTag(notATag, USER, KEY), null);
  }
  assert.equal(evalTag.verifyEvalTag(tagFor(USER), USER, null), null);
  assert.equal(evalTag.verifyEvalTag(tagFor(USER), "", KEY), null);
});

// ── POST /chat_sessions ──────────────────────────────────────────────────

test("a valid tag sets the server-only columns", async () => {
  const tag = tagFor(USER, { mode: "standard" });
  const { res, insert } = await createSession({ title: "t", eval: tag });
  assert.equal(res.statusCode, 201);
  assert.ok(tagged(insert));
  assert.ok(insert.values.includes(tag.run_id));
  assert.ok(insert.values.includes("standard"));
  // Nothing about the tag is echoed back.
  assert.ok(!res.body.includes(tag.run_id));
  assert.ok(!res.body.includes(tag.sig));
});

test("invalid tags create a normal session", async () => {
  for (const tag of [
    tagFor(OTHER_USER),
    tagFor(USER, { exp: now() - 10 }),
    { ...tagFor(USER), mode: "standard" },
    tagFor(USER, { run_id: "bad id" }),
  ]) {
    const { res, insert } = await createSession({ eval: tag });
    assert.equal(res.statusCode, 201);
    assert.ok(!tagged(insert));
  }
});

test("missing secret configuration fails closed", async () => {
  // No env var.
  let out = await createSession({ eval: tagFor(USER) }, { env: false });
  assert.equal(out.res.statusCode, 201);
  assert.ok(!tagged(out.insert));

  // Secret fetch fails (EvalStack not deployed).
  const notFound = Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
  out = await createSession({ eval: tagFor(USER) }, { secrets: { [SECRET_NAME]: notFound } });
  assert.equal(out.res.statusCode, 201);
  assert.ok(!tagged(out.insert));

  // Secret present but without a usable key.
  out = await createSession({ eval: tagFor(USER) }, { secrets: { [SECRET_NAME]: JSON.stringify({ signingKey: "short" }) } });
  assert.ok(!tagged(out.insert));
});

test("a tag placed inside metadata is ignored", async () => {
  const tag = tagFor(USER);
  const { insert } = await createSession({ metadata: { eval: tag, eval_run_id: tag.run_id } });
  assert.ok(!tagged(insert));
});

test("neither the tag nor the signing key is logged", async () => {
  const tag = tagFor(USER);
  const ok = await createSession({ eval: tag });
  const notFound = Object.assign(new Error(`boom ${KEY}`), { name: "ResourceNotFoundException" });
  const failed = await createSession({ eval: tag }, { secrets: { [SECRET_NAME]: notFound } });
  for (const { logs } of [ok, failed]) {
    assert.ok(!logs.includes(tag.sig), "signature logged");
    assert.ok(!logs.includes(KEY), "signing key logged");
    assert.ok(!logs.includes(tag.run_id), "run id logged");
  }
});
