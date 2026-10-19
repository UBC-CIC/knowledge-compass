const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");

const secretsManager = new SecretsManagerClient();
let cachedSecret;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Must match ACCESS_AUDIENCE in handlers/utils/userCredential.js.
const ACCESS_AUDIENCE = "kc-public-api";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  const token = event.authorizationToken?.replace("Bearer ", "");

  if (!token) {
    console.warn("No token provided");
    throw new Error("Unauthorized");
  }

  const issuer = process.env.JWT_ISSUER;
  if (!issuer) {
    console.error("JWT_ISSUER is not configured");
    throw new Error("Unauthorized");
  }

  try {
    if (!cachedSecret || Date.now() > cacheExpiry) {
      const response = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
      );
      cachedSecret = JSON.parse(response.SecretString).jwtSecret;
      cacheExpiry = Date.now() + CACHE_TTL_MS;
    }

    const decoded = jwt.verify(token, cachedSecret, { algorithms: ["HS256"] });

    // Only this deployment's access tokens authorize API calls. The long-lived
    // per-user credential (typ "credential", aud "kc-token-exchange") only buys
    // access tokens from /user/publicToken.
    if (decoded?.typ !== "access" || decoded.iss !== issuer || decoded.aud !== ACCESS_AUDIENCE) {
      throw new Error("not an access token for this API");
    }

    // Extract API Gateway ARN parts to create wildcard resource
    // methodArn format: arn:aws:execute-api:region:account:apiId/stage/method/resource
    const arnParts = event.methodArn.split('/');
    const apiGatewayArnPrefix = arnParts.slice(0, 2).join('/'); // arn:aws:execute-api:region:account:apiId/stage
    const wildcardResource = `${apiGatewayArnPrefix}/*/*`; // Allow all methods and resources

    // tokenId is the access token's random jti (userCredential.js), for audit
    // correlation only ($context.authorizer.* in the API access log). It is
    // never an identity: anonymous tokens get principalId "anonymous:<jti>"
    // so each token is distinguishable, while userId stays empty.
    const tokenId =
      typeof decoded.jti === "string" && UUID_REGEX.test(decoded.jti) ? decoded.jti : "";
    const policy = generatePolicy(
      decoded.sub || (tokenId ? `anonymous:${tokenId}` : "anonymous"),
      "Allow",
      wildcardResource
    );
    // userId is the only caller identity handlers may trust. Anonymous tokens
    // (issued without a credential) carry none, so user and session routes
    // reject them. Only known scalar claims are forwarded.
    policy.context = {
      userId: typeof decoded.sub === "string" ? decoded.sub : "",
      role: typeof decoded.role === "string" ? decoded.role : "user",
      tokenId,
    };
    return policy;
  } catch (err) {
    console.error("Authorization error:", err.message);
    throw new Error("Unauthorized");
  }
};

function generatePolicy(principalId, effect, resource) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
  };
}