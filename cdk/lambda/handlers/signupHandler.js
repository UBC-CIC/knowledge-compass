const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { createResponse } = require("./utils/handlerUtils");

const { USER_POOL_ID } = process.env;
const cognitoClient = new CognitoIdentityProviderClient();

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return createResponse(200, {});
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return createResponse(400, { error: "Invalid JSON body" });
  }

  const { email } = body;
  if (!email || !email.includes("@")) {
    return createResponse(400, { error: "A valid email address is required" });
  }

  try {
    await cognitoClient.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    }));

    return createResponse(200, { message: "Account created. Check your email for a temporary password." });
  } catch (err) {
    if (err.name === "UsernameExistsException") {
      return createResponse(409, { error: "An account with this email already exists." });
    }
    console.error("AdminCreateUser error:", err);
    return createResponse(500, { error: "Failed to create account. Please try again." });
  }
};
