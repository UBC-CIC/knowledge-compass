/**
 * Anonymous users' credentials and access tokens.
 *
 * - POST /user returns a credential: a JWT typed "credential" carrying the
 *   user id and users.credential_version (migration 033). The browser keeps it
 *   with its user id.
 * - GET /user/publicToken exchanges it for a 15-minute access token bound to
 *   that user (exchangeCredential). Without a credential the access token is
 *   anonymous and can only create a user or read public settings.
 *
 * Credentials are revocable and short-lived:
 * - the user must still exist and the credential's version must be current;
 * - a credential older than ROTATE_AFTER_SECONDS is rotated on exchange: the
 *   version is bumped and a new credential is returned with the token, so an
 *   active user's credential changes daily and lapses after 30 idle days;
 * - right after a rotation the previous version still gets an access token
 *   (never a new credential) for ROTATION_GRACE_SECONDS, since another tab may
 *   have exchanged at the same time;
 * - any older version is refused. Revoking everything on reuse would let
 *   anyone holding a stale copy lock the real user out, so it is not done.
 *   Bumping users.credential_version revokes all of a user's credentials.
 *
 * All tokens are HS256 with the shared JWT secret and carry iss (JWT_ISSUER,
 * the deployment) and aud: ACCESS_AUDIENCE for access tokens, CREDENTIAL_AUDIENCE
 * for credentials. Every verifier (user authorizer, WebSocket $connect and
 * $default, credential exchange) checks typ, iss and aud, so a credential
 * cannot be used as an access token. There is no jti: revocation is
 * users.credential_version, and access tokens expire after 15 minutes.
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");

const CREDENTIAL_LIFETIME = "30d";
const ACCESS_TOKEN_LIFETIME = "15m";
const ROTATE_AFTER_SECONDS = 24 * 60 * 60;
const ROTATION_GRACE_SECONDS = 120;
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_AUDIENCE = "kc-public-api";
const CREDENTIAL_AUDIENCE = "kc-token-exchange";

const secretsManager = new SecretsManagerClient();
let cachedSecret;
let cacheExpiry = 0;

async function jwtSecret() {
  if (!cachedSecret || Date.now() > cacheExpiry) {
    const response = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
    );
    cachedSecret = JSON.parse(response.SecretString).jwtSecret;
    cacheExpiry = Date.now() + SECRET_CACHE_TTL_MS;
  }
  if (!cachedSecret) throw new Error("JWT secret is not configured");
  return cachedSecret;
}

/** The deployment's token issuer. Fails closed (500) when unset. */
function issuer() {
  const value = process.env.JWT_ISSUER;
  if (!value) throw new Error("JWT_ISSUER is not configured");
  return value;
}

/** Sign a credential for `userId` at credential `version`. */
async function issueUserCredential(userId, version) {
  // Fail closed: a missing version (e.g. migration 033 not applied) must not
  // mint credentials the version check cannot track.
  if (!Number.isInteger(version)) throw new Error("credential_version is missing");
  const claims = { typ: "credential", sub: userId, ver: version, iss: issuer(), aud: CREDENTIAL_AUDIENCE };
  return jwt.sign(claims, await jwtSecret(), {
    algorithm: "HS256",
    expiresIn: CREDENTIAL_LIFETIME,
  });
}

/** Sign a 15-minute access token, bound to `userId` when given. */
async function issueAccessToken(userId) {
  const claims = { role: "user", typ: "access", iss: issuer(), aud: ACCESS_AUDIENCE };
  if (userId) claims.sub = userId;
  return jwt.sign(claims, await jwtSecret(), {
    algorithm: "HS256",
    expiresIn: ACCESS_TOKEN_LIFETIME,
  });
}

/** Verified credential claims, or null when the token is not a usable credential. */
async function verifyCredential(credential) {
  // Configuration and Secrets Manager failures throw (userHandler maps them to
  // 500) instead of returning null, because null becomes 401 invalid_credential
  // and the browser then discards its stored identity. A 500 keeps the
  // credential for in-session callers; at page load UserContext.validateUser
  // still treats any failure as invalid (pre-existing, tracked as a follow-up).
  const iss = issuer();
  const secret = await jwtSecret();
  let decoded;
  try {
    decoded = jwt.verify(credential, secret, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
  if (
    !decoded ||
    decoded.typ !== "credential" ||
    typeof decoded.sub !== "string" ||
    !UUID_REGEX.test(decoded.sub) ||
    !Number.isInteger(decoded.ver) ||
    !Number.isInteger(decoded.iat)
  ) {
    return null;
  }
  if (decoded.iss !== undefined || decoded.aud !== undefined) {
    if (decoded.iss !== iss || decoded.aud !== CREDENTIAL_AUDIENCE) return null;
  } else {
    // Issued before iss/aud existed: accepted once and rotated on this exchange.
    decoded.legacy = true;
  }
  return decoded;
}

const secondsSince = (date, now) => (now - new Date(date).getTime()) / 1000;

/**
 * Exchange a credential for an access token.
 * Returns { token, credential? } (credential only when it was rotated or
 * refreshed) or null when the caller must start a new anonymous user.
 */
async function exchangeCredential(sql, credential, now = Date.now()) {
  const claims = await verifyCredential(credential);
  if (!claims) return null;
  const userId = claims.sub;

  const rows = await sql`
    SELECT credential_version, credential_rotated_at
    FROM users
    WHERE id = ${userId}
  `;
  if (rows.length === 0) return null; // user deleted
  let current = rows[0].credential_version;
  let rotatedAt = rows[0].credential_rotated_at;

  if (claims.ver === current) {
    const ageSeconds = now / 1000 - claims.iat;
    // TODO(after <deploy>+30d): drop the legacy branch; by then no credential
    // without iss/aud can still be valid (CREDENTIAL_LIFETIME).
    if (ageSeconds < ROTATE_AFTER_SECONDS && !claims.legacy) {
      return { token: await issueAccessToken(userId) };
    }
    // Rotate. The version guard makes concurrent exchanges rotate only once.
    const rotated = await sql`
      UPDATE users
      SET credential_version = credential_version + 1,
          credential_rotated_at = NOW()
      WHERE id = ${userId} AND credential_version = ${current}
      RETURNING credential_version
    `;
    if (rotated.length === 1) {
      return {
        token: await issueAccessToken(userId),
        credential: await issueUserCredential(userId, rotated[0].credential_version),
      };
    }
    // Another request rotated first; fall through to the grace check.
    const latest = await sql`
      SELECT credential_version, credential_rotated_at
      FROM users
      WHERE id = ${userId}
    `;
    if (latest.length === 0) return null;
    current = latest[0].credential_version;
    rotatedAt = latest[0].credential_rotated_at;
  }

  if (
    claims.ver === current - 1 &&
    rotatedAt &&
    secondsSince(rotatedAt, now) <= ROTATION_GRACE_SECONDS
  ) {
    // Concurrent exchange right after a rotation (another tab). Only a
    // short-lived access token: a superseded credential is never upgraded to
    // the current one, and the other tab already stored the replacement.
    return { token: await issueAccessToken(userId) };
  }

  // Superseded (or unknown) version: refuse it. Nothing is revoked here,
  // because this endpoint is unauthenticated and a stale copy must not let
  // anyone lock the real user out.
  if (claims.ver < current) {
    console.warn("Rejected a superseded user credential");
  }
  return null;
}

module.exports = {
  issueUserCredential,
  issueAccessToken,
  exchangeCredential,
  ROTATE_AFTER_SECONDS,
  ROTATION_GRACE_SECONDS,
  ACCESS_AUDIENCE,
  CREDENTIAL_AUDIENCE,
};
