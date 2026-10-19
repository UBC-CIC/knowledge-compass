/**
 * Unit tests for GET /user/publicToken in handlers/userHandler.js and the
 * credential rules in utils/userCredential.js: existence and version checks,
 * daily rotation, the post-rotation grace window, and revocation when a
 * superseded credential is reused. Fake SQL client and jsonwebtoken:
 *
 *   node --test cdk/lambda/handlers/tests/credentialExchange.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeSql, loadHandler, quietly, fakeToken, decodeFakeToken } = require("./_loadHandler.js");

const USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11";
const DAY = 24 * 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);

const ISSUER = "test-issuer";

const credential = ({ ver = 0, iat = nowSeconds(), ...rest } = {}) =>
  fakeToken({ typ: "credential", sub: USER, ver, iat, iss: ISSUER, aud: "kc-token-exchange", ...rest });

test.beforeEach(() => {
  process.env.JWT_ISSUER = ISSUER;
});

// In-memory users row; null = user does not exist.
function usersSql(row = { credential_version: 0, credential_rotated_at: null }) {
  const state = { row };
  const sql = fakeSql((text, values) => {
    if (text.startsWith("SELECT credential_version")) return state.row ? [{ ...state.row }] : [];
    if (text.startsWith("UPDATE users SET credential_version = credential_version + 1")) {
      const expected = values[values.length - 1];
      if (!state.row || state.row.credential_version !== expected) return [];
      state.row = {
        credential_version: state.row.credential_version + 1,
        credential_rotated_at: text.includes("credential_rotated_at = NOW()") ? new Date() : null,
      };
      return [{ credential_version: state.row.credential_version }];
    }
    return [];
  });
  sql.state = state;
  return sql;
}

async function exchange(sql, token) {
  const { handler } = loadHandler("userHandler", sql);
  const event = { httpMethod: "GET", resource: "/user/publicToken", headers: {} };
  if (token) event.headers.Authorization = `Bearer ${token}`;
  const res = await quietly(() => handler(event));
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

test("no credential: anonymous access token without touching the database", async () => {
  const sql = usersSql();
  const res = await exchange(sql, null);
  assert.equal(res.statusCode, 200);
  const { payload, options } = decodeFakeToken(res.body.token);
  assert.equal(payload.sub, undefined);
  assert.equal(payload.typ, "access");
  assert.equal(options.expiresIn, "15m");
  assert.equal(options.algorithm, "HS256");
  assert.equal(sql.calls.length, 0);
});

test("current, fresh credential: bound access token and no rotation", async () => {
  const sql = usersSql();
  const res = await exchange(sql, credential());
  assert.equal(res.statusCode, 200);
  assert.equal(decodeFakeToken(res.body.token).payload.sub, USER);
  assert.equal(res.body.credential, undefined);
  assert.equal(sql.state.row.credential_version, 0);
  // Only guest rows can exchange a credential (staff rows never get a user token).
  const select = sql.queries().find((q) => q.text.startsWith("SELECT credential_version"));
  assert.ok(select.text.includes("identity_source = 'guest'"));
});

test("credential older than a day is rotated and a replacement returned", async () => {
  const sql = usersSql();
  const res = await exchange(sql, credential({ iat: nowSeconds() - DAY - 5 }));
  assert.equal(res.statusCode, 200);
  assert.equal(sql.state.row.credential_version, 1);
  const replacement = decodeFakeToken(res.body.credential);
  assert.equal(replacement.payload.ver, 1);
  assert.equal(replacement.payload.sub, USER);
  assert.equal(replacement.options.expiresIn, "30d");

  // The replacement works; nothing rotates again.
  const again = await exchange(sql, res.body.credential);
  assert.equal(again.statusCode, 200);
  assert.equal(sql.state.row.credential_version, 1);
});

test("previous version right after rotation (another tab) gets an access token only", async () => {
  const sql = usersSql({ credential_version: 1, credential_rotated_at: new Date(Date.now() - 30_000) });
  const res = await exchange(sql, credential({ ver: 0, iat: nowSeconds() - DAY - 60 }));
  assert.equal(res.statusCode, 200);
  assert.equal(decodeFakeToken(res.body.token).payload.sub, USER);
  assert.equal(res.body.credential, undefined, "a superseded credential is never upgraded");
  assert.equal(sql.state.row.credential_version, 1, "grace does not rotate again");
});

test("a superseded credential is refused without locking out the current one", async () => {
  // Rotated 10 minutes ago, outside the grace window: a stale or leaked copy.
  const rotatedAt = new Date(Date.now() - 600_000);
  const sql = usersSql({ credential_version: 3, credential_rotated_at: rotatedAt });
  const res = await exchange(sql, credential({ ver: 2 }));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "invalid_credential" });
  assert.equal(sql.state.row.credential_version, 3, "nothing is revoked");
  assert.equal(sql.state.row.credential_rotated_at, rotatedAt);

  // The real user's current credential keeps working.
  assert.equal((await exchange(sql, credential({ ver: 3 }))).statusCode, 200);
});

test("bumping credential_version revokes outstanding credentials", async () => {
  const sql = usersSql({ credential_version: 1, credential_rotated_at: null });
  assert.equal((await exchange(sql, credential({ ver: 0 }))).statusCode, 401);
});

test("deleted users and malformed, forged or wrong-type credentials are refused", async () => {
  assert.equal((await exchange(usersSql(null), credential())).statusCode, 401);

  for (const token of [
    "garbage",
    fakeToken({ typ: "credential", sub: USER, ver: 0, iat: nowSeconds() }, "other-secret"),
    fakeToken({ typ: "access", sub: USER, ver: 0, iat: nowSeconds() }),
    fakeToken({ typ: "credential", sub: "user", ver: 0, iat: nowSeconds() }),
    fakeToken({ typ: "credential", sub: USER, iat: nowSeconds() }), // pre-version credential
    fakeToken({ typ: "credential", sub: USER, ver: "0", iat: nowSeconds() }),
  ]) {
    const sql = usersSql();
    const res = await exchange(sql, token);
    assert.equal(res.statusCode, 401, token);
    assert.equal(sql.state.row.credential_version, 0, "nothing is revoked for an unverifiable token");
  }
});

test("tokens carry iss and aud and no jti", async () => {
  const anonymous = decodeFakeToken((await exchange(usersSql(), null)).body.token).payload;
  assert.equal(anonymous.iss, ISSUER);
  assert.equal(anonymous.aud, "kc-public-api");
  assert.equal(anonymous.jti, undefined);

  const sql = usersSql();
  const res = await exchange(sql, credential({ iat: nowSeconds() - DAY - 5 }));
  const access = decodeFakeToken(res.body.token).payload;
  assert.deepEqual(
    { typ: access.typ, role: access.role, sub: access.sub, iss: access.iss, aud: access.aud, jti: access.jti },
    { typ: "access", role: "user", sub: USER, iss: ISSUER, aud: "kc-public-api", jti: undefined }
  );
  const replacement = decodeFakeToken(res.body.credential).payload;
  assert.equal(replacement.typ, "credential");
  assert.equal(replacement.iss, ISSUER);
  assert.equal(replacement.aud, "kc-token-exchange");
  assert.equal(replacement.jti, undefined);
});

test("a fresh legacy credential (no iss/aud) is accepted once and rotated", async () => {
  const sql = usersSql();
  const legacy = fakeToken({ typ: "credential", sub: USER, ver: 0, iat: nowSeconds() });
  const res = await exchange(sql, legacy);
  assert.equal(res.statusCode, 200);
  assert.equal(decodeFakeToken(res.body.token).payload.sub, USER);
  assert.equal(sql.state.row.credential_version, 1);
  const replacement = decodeFakeToken(res.body.credential).payload;
  assert.equal(replacement.iss, ISSUER);
  assert.equal(replacement.aud, "kc-token-exchange");
  assert.equal(replacement.ver, 1);
});

test("credentials with a wrong or partial iss/aud are refused", async () => {
  for (const claims of [
    { aud: "kc-public-api" },
    { iss: "other-deployment" },
    { iss: undefined },
    { aud: undefined },
  ]) {
    const token = fakeToken({
      typ: "credential", sub: USER, ver: 0, iat: nowSeconds(), iss: ISSUER, aud: "kc-token-exchange", ...claims,
    });
    const sql = usersSql();
    const res = await exchange(sql, token);
    assert.equal(res.statusCode, 401, JSON.stringify(claims));
    assert.deepEqual(res.body, { error: "invalid_credential" });
    assert.equal(sql.state.row.credential_version, 0);
  }
});

test("unset JWT_ISSUER is a 500, never 401 invalid_credential", async () => {
  delete process.env.JWT_ISSUER;
  try {
    const res = await exchange(usersSql(), credential());
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "Internal server error" });
    assert.notEqual(res.body.error, "invalid_credential");
  } finally {
    process.env.JWT_ISSUER = ISSUER;
  }
});

test("a Secrets Manager failure during exchange is a 500, never 401", async () => {
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-jwt-secret-id";
  try {
    const { handler } = loadHandler("userHandler", usersSql(), {
      secrets: { "test-jwt-secret-id": new Error("sm down") },
    });
    const event = {
      httpMethod: "GET", resource: "/user/publicToken", headers: { Authorization: `Bearer ${credential()}` },
    };
    const res = await quietly(() => handler(event));
    assert.equal(res.statusCode, 500);
    assert.notEqual(JSON.parse(res.body).error, "invalid_credential");
  } finally {
    if (saved === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved;
  }
});

test("exchangeCredential rejects (does not resolve null) when JWT_ISSUER is unset", async () => {
  const utils = loadHandler("utils/userCredential", usersSql());
  delete process.env.JWT_ISSUER;
  try {
    await assert.rejects(utils.exchangeCredential(usersSql(), credential()), /JWT_ISSUER is not configured/);
  } finally {
    process.env.JWT_ISSUER = ISSUER;
  }
});

test("a credential from a newer version than stored is refused without revoking", async () => {
  const sql = usersSql({ credential_version: 0, credential_rotated_at: null });
  const res = await exchange(sql, credential({ ver: 5 }));
  assert.equal(res.statusCode, 401);
  assert.equal(sql.state.row.credential_version, 0);
});
