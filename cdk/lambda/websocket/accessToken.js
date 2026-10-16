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

const secretsManager = new SecretsManagerClient();
let cachedSecret;
let cacheExpiry = 0;

async function jwtSecret() {
  if (!cachedSecret || Date.now() > cacheExpiry) {
    const response = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
    );
    cachedSecret = JSON.parse(response.SecretString).jwtSecret;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
  }
  if (!cachedSecret) throw new Error("JWT secret is not configured");
  return cachedSecret;
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
  const secret = await jwtSecret();
  let decoded;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
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
