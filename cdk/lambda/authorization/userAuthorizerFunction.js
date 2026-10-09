const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");

const secretsManager = new SecretsManagerClient();
let cachedSecret;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

exports.handler = async (event) => {
  const token = event.authorizationToken?.replace("Bearer ", "");

  if (!token) {
    console.warn("No token provided");
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

    // The long-lived per-user credential only buys access tokens from
    // /user/publicToken; it must never authorize API calls itself.
    if (decoded.typ === "credential") {
      throw new Error("credential tokens are not access tokens");
    }

    // Extract API Gateway ARN parts to create wildcard resource
    // methodArn format: arn:aws:execute-api:region:account:apiId/stage/method/resource
    const arnParts = event.methodArn.split('/');
    const apiGatewayArnPrefix = arnParts.slice(0, 2).join('/'); // arn:aws:execute-api:region:account:apiId/stage
    const wildcardResource = `${apiGatewayArnPrefix}/*/*`; // Allow all methods and resources

    const policy = generatePolicy(
      decoded.sub || "anonymous",
      "Allow",
      wildcardResource
    );
    // userId is the only caller identity handlers may trust. Anonymous tokens
    // (issued without a credential) carry none, so user and session routes
    // reject them. Only known scalar claims are forwarded.
    policy.context = {
      userId: typeof decoded.sub === "string" ? decoded.sub : "",
      role: typeof decoded.role === "string" ? decoded.role : "user",
      jti: typeof decoded.jti === "string" ? decoded.jti : "",
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