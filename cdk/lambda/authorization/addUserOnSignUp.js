const { initializeConnection } = require("./initializeConnection.js");
const {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;
let sqlConnection = global.sqlConnection;
const cognitoClient = new CognitoIdentityProviderClient();

exports.handler = async (event) => {
  console.log("Post-authentication trigger:", {
    userName: event.userName,
    userPoolId: event.userPoolId,
    triggerSource: event.triggerSource,
  });

  if (!sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnection = global.sqlConnection;
  }

  const { userName, userPoolId, request } = event;

  try {
    const userAttributes = request.userAttributes;
    const sub = userAttributes.sub;
    const email = userAttributes.email || "";

    const givenName = userAttributes.given_name || "";
    const familyName = userAttributes.family_name || "";
    const displayName = `${givenName} ${familyName}`.trim() || email;

    console.log("Upserting user:", { sub });

    await sqlConnection`
      INSERT INTO users (id, display_name, email, created_at, last_seen_at)
      VALUES (${sub}::uuid, ${displayName}, ${email}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          last_seen_at = CURRENT_TIMESTAMP
    `;

    try {
      await cognitoClient.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: userName,
        GroupName: "users",
      }));
    } catch (groupErr) {
      console.warn("Could not add user to group (may already be a member):", groupErr.message);
    }

  } catch (err) {
    console.error("Error in post-authentication trigger:", err);
  }

  return event;
};
