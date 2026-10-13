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

const credential = ({ ver = 0, iat = nowSeconds(), ...rest } = {}) =>
  fakeToken({ typ: "credential", sub: USER, ver, iat, ...rest });

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

test("a credential from a newer version than stored is refused without revoking", async () => {
  const sql = usersSql({ credential_version: 0, credential_rotated_at: null });
  const res = await exchange(sql, credential({ ver: 5 }));
  assert.equal(res.statusCode, 401);
  assert.equal(sql.state.row.credential_version, 0);
});
