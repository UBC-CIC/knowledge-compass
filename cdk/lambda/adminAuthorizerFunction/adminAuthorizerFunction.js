const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { CognitoJwtVerifier } = require("aws-jwt-verify");

const secretsManager = new SecretsManagerClient();

let { SM_COGNITO_CREDENTIALS } = process.env;
let jwtVerifier;

function extractToken(authorizationToken) {
  const raw = (authorizationToken ?? "").toString().trim();
  if (/^bearer\s+/i.test(raw)) {
    return raw.replace(/^bearer\s+/i, "").trim();
  }
  return raw;
}

async function initializeConnection() {
  try {
    const secretResponse = await secretsManager.send(
      new GetSecretValueCommand({
        SecretId: SM_COGNITO_CREDENTIALS,
      })
    );

    const credentials = JSON.parse(secretResponse.SecretString);

    jwtVerifier = CognitoJwtVerifier.create({
      userPoolId: credentials.VITE_COGNITO_USER_POOL_ID,
      tokenUse: "id",
      clientId: credentials.VITE_COGNITO_USER_POOL_CLIENT_ID,
    });
  } catch (error) {
    console.error("Error initializing JWT verifier:", error);
    throw new Error("Failed to initialize JWT verifier");
  }
}

exports.handler = async (event) => {
  if (!jwtVerifier) {
    await initializeConnection();
  }

  try {
    const token = extractToken(event.authorizationToken);
    const payload = await jwtVerifier.verify(token);

    const parts = event.methodArn.split("/");
    const resource = parts.slice(0, 2).join("/") + "*";

    return {
      principalId: payload.sub,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
            Resource: resource,
          },
        ],
      },
      context: {
        userId: payload.sub,
        email: payload.email,
        role: "admin",
      },
    };
  } catch (error) {
    console.error("Authorization error:", error);
    // API Gateway wants this *exact* error message, otherwise it returns 500 instead of 401:
    throw new Error("Unauthorized");
  }
};
