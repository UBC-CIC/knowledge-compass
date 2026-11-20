/**
 * Verifies the public access tokens minted by handlers/utils/userCredential.js
 * (this directory is a separate Lambda asset and cannot import from handlers/).
 * Used by $connect (to bind the connection) and $default (per frame).
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");

// Must match ACCESS_AUDIENCE in handlers/utils/userCredential.js.
const ACCESS_AUDIENCE = "kc-public-api";
const CACHE_TTL_MS = 5 * 60 * 1000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A signature that matches no cached key refetches the secret (it may have
// just rotated), at most this often per container.
const REFRESH_MIN_INTERVAL_MS = 30 * 1000;

const secretsManager = new SecretsManagerClient();
let cachedKeys;
let cachedAt = 0;

// Current and previous signing keys (appSecretRotation keeps the outgoing key
// as previousJwtSecret), so a rotation does not invalidate live tokens.
async function jwtKeys(refresh = false) {
  const age = Date.now() - cachedAt;
  if (!cachedKeys || age > CACHE_TTL_MS || (refresh && age > REFRESH_MIN_INTERVAL_MS)) {
    const response = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
    );
    const secret = JSON.parse(response.SecretString);
    cachedKeys = [secret.jwtSecret, secret.previousJwtSecret].filter((k) => typeof k === "string" && k);
    cachedAt = Date.now();
  }
  if (cachedKeys.length === 0) throw new Error("JWT secret is not configured");
  return cachedKeys;
}

const SIGNATURE_MISMATCH = Symbol("signature mismatch");

/**
 * Claims verified against the first key that signed `token`; null when the
 * token is invalid for another reason (expired, malformed), which holds for
 * every key; SIGNATURE_MISMATCH when no key signed it.
 */
function verifyWithKeys(token, keys) {
  for (const key of keys) {
    try {
      return jwt.verify(token, key, { algorithms: ["HS256"] });
    } catch (err) {
      if (err?.message !== "invalid signature") return null;
    }
  }
  return SIGNATURE_MISMATCH;
}

/** verifyWithKeys, refetching the keys once on a mismatch (they may have just rotated). */
async function verifyJwt(token) {
  let decoded = verifyWithKeys(token, await jwtKeys());
  if (decoded === SIGNATURE_MISMATCH) decoded = verifyWithKeys(token, await jwtKeys(true));
  return decoded === SIGNATURE_MISMATCH ? null : decoded;
}

/**
 * The user id (`sub`) of a valid user-bound access token, or null.
 *
 * Null for: a missing token, a bad signature or expiry, typ other than
 * "access", iss other than JWT_ISSUER (or JWT_ISSUER unset), aud other than
 * ACCESS_AUDIENCE, or a sub that is not a UUID (anonymous bootstrap tokens).
 * Throws (callers map it to 500, never 401) only on a configuration or
 * infrastructure fault: JWT_ISSUER unset or the secret cannot be fetched.
 * Every token is refused either way; the throw keeps a server fault from
 * looking like a bad token.
 */
async function verifyAccessToken(token) {
  if (typeof token !== "string" || !token) return null;
  const issuer = process.env.JWT_ISSUER;
  if (!issuer) throw new Error("JWT_ISSUER is not configured");
  const decoded = await verifyJwt(token);
  if (
    !decoded ||
    decoded.typ !== "access" ||
    decoded.iss !== issuer ||
    decoded.aud !== ACCESS_AUDIENCE ||
    typeof decoded.sub !== "string" ||
    !UUID_REGEX.test(decoded.sub)
  ) {
    return null;
  }
  return decoded.sub;
}

module.exports = { verifyAccessToken, ACCESS_AUDIENCE, UUID_REGEX };
