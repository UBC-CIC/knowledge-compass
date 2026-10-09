/**
 * Per-user credential for anonymous users.
 *
 * POST /user returns it once; the browser keeps it with its user id and sends
 * it to /user/publicToken to get short-lived access tokens bound to that user
 * (see publicTokenFunction.js). It is signed with the same JWT secret, typed
 * "credential" so the user authorizer refuses it as an access token.
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");

const CREDENTIAL_LIFETIME = "365d";
const CACHE_TTL_MS = 5 * 60 * 1000;

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

/** Sign a long-lived credential for `userId`. */
async function issueUserCredential(userId) {
  return jwt.sign({ typ: "credential", sub: userId }, await jwtSecret(), {
    algorithm: "HS256",
    expiresIn: CREDENTIAL_LIFETIME,
  });
}

module.exports = { issueUserCredential };
