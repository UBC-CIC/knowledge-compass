const { initializeConnection } = require("./initializeConnection.js");
const {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { ensureStaffUser } = require("./staffIdentity.js");

const cognito = new CognitoIdentityProviderClient({});
const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;
let sqlConnection = global.sqlConnection;

exports.handler = async (event) => {
  console.log("Post-confirmation trigger:", {
    userPoolId: event.userPoolId,
    triggerSource: event.triggerSource,
  });

  if (!sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnection = global.sqlConnection;
  }

  const { userName, request } = event;

  try {
    // Extract user attributes from the event
    const userAttributes = request.userAttributes || {};
    const sub = typeof userAttributes.sub === "string" ? userAttributes.sub.trim() : "";
    const email = (userAttributes.email || "").trim().toLowerCase();
    const givenName = userAttributes.given_name || "";
    const familyName = userAttributes.family_name || "";
    const displayName = `${givenName} ${familyName}`.trim() || email;

    // The users row is keyed on the Cognito sub, never on email (a guest can
    // write users.email; see staffIdentity.js).
    if (!sub) {
      console.error("Post-confirmation event is missing sub; skipping users insert");
      return event;
    }

    // Admin accounts are provisioned out-of-band (see Docs/DEPLOYMENT_GUIDE.md
    // "Configure Admin User"): an existing admin creates the Cognito user and
    // adds them to the "admin" group BEFORE the user ever confirms. Reflect
    // that group membership into the users table instead of granting admin by
    // default — self-service sign-ups (gated only by preSignUp's allowed
    // email-domain check) must start as unprivileged 'student' accounts.
    let role = "student";
    try {
      const groups = await cognito.send(
        new AdminListGroupsForUserCommand({
          Username: userName,
          UserPoolId: event.userPoolId,
        })
      );
      if (groups.Groups?.some((g) => g.GroupName === "admin")) {
        role = "admin";
      }
    } catch (groupErr) {
      console.error("Failed to look up Cognito group membership; defaulting to 'student':", groupErr?.message);
    }

    // Find (by sub), link (legacy staff row) or create the staff row. A guest
    // row holding this email loses the address and is never captured. On
    // re-confirmation of an existing account, leave the role untouched —
    // role changes go through POST /admin/promote_user, not this trigger.
    const result = await ensureStaffUser(sqlConnection, {
      sub,
      email: email || null,
      displayName,
      role,
      elevate: false,
    });

    console.log({ triggerSource: event.triggerSource, role: result.role, outcome: result.outcome });

    // IMPORTANT: For Cognito triggers, you must return the event object
    return event;
  } catch (err) {
    console.error("Error inserting user into database:", err?.message);
    // Even on error, return the event to allow sign-up to complete
    // The user can still authenticate, but won't be in the database yet
    return event;
  }
};
