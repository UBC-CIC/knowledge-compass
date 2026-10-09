const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");
const { getCorsHeaders } = require("./cors.js");
const { randomUUID } = require("crypto");

const secretsManager = new SecretsManagerClient();
let cachedSecret;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bearer value of the Authorization header, or null. */
function bearerToken(event) {
  const headers = event?.headers || {};
  const value = headers.Authorization || headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim() || null;
}

/**
 * Issues a 15-minute access token.
 *
 * - With `Authorization: Bearer <credential>` (the per-user credential that
 *   POST /user returns), the token's `sub` is that user, which is what user and
 *   session routes require. An invalid or expired credential is a 401 so the
 *   client knows to start a new anonymous user.
 * - Without a credential the token is anonymous (no `sub`): it can only create
 *   a user and read public settings.
 */
exports.handler = async (event) => {
  try {
    if (!cachedSecret || Date.now() > cacheExpiry) {
      const response = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
      );
      cachedSecret = JSON.parse(response.SecretString).jwtSecret;
      cacheExpiry = Date.now() + CACHE_TTL_MS;
    }

    const claims = {
      role: "user",
      typ: "access",
      jti: randomUUID(), // Unique token ID for tracking/revocation
      iat: Math.floor(Date.now() / 1000), // Explicit issued-at timestamp
    };

    const credential = bearerToken(event);
    if (credential) {
      let decoded;
      try {
        decoded = jwt.verify(credential, cachedSecret, { algorithms: ["HS256"] });
      } catch {
        decoded = null;
      }
      if (!decoded || decoded.typ !== "credential" || !UUID_REGEX.test(decoded.sub || "")) {
        return {
          statusCode: 401,
          headers: await getCorsHeaders(event),
          body: JSON.stringify({ error: "invalid_credential" }),
        };
      }
      claims.sub = decoded.sub;
    }

    const token = jwt.sign(claims, cachedSecret, {
      algorithm: "HS256",
      expiresIn: "15m", // Short-lived; clients refresh with their credential
    });
    return {
      statusCode: 200,
      headers: await getCorsHeaders(event),
      body: JSON.stringify({ token }),
    };
  } catch (error) {
    console.error("Token generation error:", error);
    return {
      statusCode: 500,
      headers: await getCorsHeaders(event),
      body: JSON.stringify({ error: "Failed to generate token" }),
    };
  }
};
