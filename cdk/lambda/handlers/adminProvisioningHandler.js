/**
 * POST /admin/users: create (or re-provision) an administrator.
 *
 * Its own Lambda and role on purpose: this is the only request handler allowed
 * to call Cognito admin APIs (AdminCreateUser, AdminGetUser,
 * AdminAddUserToGroup, on this user pool only). Every other request handler
 * keeps the RequestHandlerBoundary deny on cognito-idp:Admin* (finding
 * f-4597100e).
 *
 * Every account in the pool is an administrator (self sign-up is disabled), so
 * an email that already has a Cognito account is made an admin too: it is
 * added to the "admin" group (idempotent) and its users row is elevated.
 * Cognito is written first, so a failed database write is repaired by
 * repeating the request.
 *
 * The new admin receives Cognito's invitation email with a temporary
 * password; TOTP is set up at first sign-in (AdminLogin.tsx).
 */

const postgres = require("postgres");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminAddUserToGroupCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { getCorsHeaders } = require("./utils/cors.js");
const { logResponse, errorSummary } = require("./utils/logging.js");
const { adminSubFromEvent } = require("./utils/adminIdentity.js");
const { ensureStaffUser, normalizeEmail } = require("../authorization/staffIdentity.js");
const { auditEntry, insertAdminAudit, logAdminAudit } = require("./utils/adminAudit.js");

const ADMIN_GROUP = "admin";
// users.email / display_name are varchar(255) (OpenAPI maxLength).
const MAX_FIELD_LENGTH = 255;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let sqlConnection;
let cognito;
const secretsManager = new SecretsManagerClient();

const initConnection = async () => {
  if (!sqlConnection) {
    try {
      const secretResponse = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: process.env.SM_DB_CREDENTIALS })
      );
      const credentials = JSON.parse(secretResponse.SecretString);
      sqlConnection = postgres({
        host: process.env.RDS_PROXY_ENDPOINT,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        database: credentials.dbname,
        ssl: { rejectUnauthorized: true },
      });
      await sqlConnection`SELECT 1`;
    } catch (error) {
      console.error("Error initializing database connection:", errorSummary(error));
      throw error;
    }
  }
};

// /admin/users serves GET (adminFunction) and POST (this function); the CORS
// header lists the path's methods (OpenAPI_Swagger_Definition.yaml).
const SERVED_METHODS = "GET,POST";

/** The Cognito sub from a user's attribute list, or null. */
const subFrom = (attributes) =>
  (attributes || []).find((a) => a.Name === "sub")?.Value || null;

/**
 * Create the Cognito user, or find the existing one. It is not an admin yet:
 * see addToAdminGroup. Returns { sub, cognito: "created" | "existing" }.
 */
async function provisionCognitoAdmin(email) {
  if (!cognito) cognito = new CognitoIdentityProviderClient({});
  const UserPoolId = process.env.USER_POOL_ID;

  let sub;
  let status = "created";
  try {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username: email,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
        DesiredDeliveryMediums: ["EMAIL"],
      })
    );
    sub = subFrom(created?.User?.Attributes);
  } catch (error) {
    if (error?.name !== "UsernameExistsException") throw error;
    status = "existing";
  }
  if (!sub) {
    const existing = await cognito.send(new AdminGetUserCommand({ UserPoolId, Username: email }));
    sub = subFrom(existing?.UserAttributes);
  }
  if (!sub) throw new Error("Cognito user has no sub");
  return { sub, cognito: status };
}

/**
 * Grant admin: group membership is what the admin authorizer checks. Called
 * only after the admin_audit row has committed (finding f-59c36519), so no
 * account becomes an admin without a record; if this fails the request is a
 * 500 and a retry is idempotent.
 */
async function addToAdminGroup(email) {
  await cognito.send(
    new AdminAddUserToGroupCommand({ UserPoolId: process.env.USER_POOL_ID, Username: email, GroupName: ADMIN_GROUP })
  );
}

const respond = (response, statusCode, body) => {
  response.statusCode = statusCode;
  response.body = JSON.stringify(body);
};

exports.handler = async (event) => {
  const response = {
    statusCode: 200,
    headers: await getCorsHeaders(event, SERVED_METHODS),
    body: "",
  };

  if (event.requestContext?.authorizer?.role !== "admin") {
    respond(response, 403, { error: "Admin access required" });
    return logAndReturn(event, response);
  }
  if (`${event.httpMethod} ${event.resource}` !== "POST /admin/users") {
    respond(response, 404, { error: "Not found" });
    return logAndReturn(event, response);
  }
  // The audit actor is the Cognito sub from the admin authorizer.
  if (!adminSubFromEvent(event)) {
    respond(response, 401, { error: "Unauthorized" });
    return logAndReturn(event, response);
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    respond(response, 400, { error: "Invalid JSON body" });
    return logAndReturn(event, response);
  }

  // Same canonical email form as every other writer (migration 041).
  const email = normalizeEmail(body?.email);
  const displayName = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  if (!displayName || !email) {
    respond(response, 400, { error: "display_name and email are required" });
    return logAndReturn(event, response);
  }
  if (!EMAIL_PATTERN.test(email) || email.length > MAX_FIELD_LENGTH || displayName.length > MAX_FIELD_LENGTH) {
    respond(response, 400, { error: "Invalid display_name or email" });
    return logAndReturn(event, response);
  }

  try {
    let provisioned;
    try {
      provisioned = await provisionCognitoAdmin(email);
    } catch (error) {
      // PreSignUp_AdminCreateUser runs authorization/preSignUp.js, which
      // rejects addresses outside ALLOWED_EMAIL_DOMAINS.
      if (error?.name === "UserLambdaValidationException") {
        respond(response, 400, { error: "Email domain is not allowed" });
        return logAndReturn(event, response);
      }
      if (error?.name === "InvalidParameterException") {
        respond(response, 400, { error: "Invalid display_name or email" });
        return logAndReturn(event, response);
      }
      throw error;
    }

    await initConnection();

    // The users row and its audit record commit or roll back together.
    let createAudit;
    const row = await ensureStaffUser(sqlConnection, {
      sub: provisioned.sub,
      email,
      displayName,
      role: "admin",
      elevate: true,
      onWrite: (tx, written) => {
        createAudit = auditEntry(event, "admin_user.create", {
          user_id: written.id,
          outcome: written.outcome,
          cognito: provisioned.cognito,
        });
        return insertAdminAudit(tx, createAudit);
      },
    });
    logAdminAudit(createAudit);
    await addToAdminGroup(email);

    respond(response, provisioned.cognito === "created" ? 201 : 200, {
      id: row.id,
      email: row.email,
      display_name: displayName,
      role: row.role,
      cognito: provisioned.cognito,
    });
  } catch (error) {
    // Name and code only: Cognito messages can quote the username (email).
    const { name, code } = errorSummary(error);
    console.error("Internal server error:", { name, code });
    respond(response, 500, { error: "Internal server error" });
  }

  return logAndReturn(event, response);
};

// Status line only, never the body (it holds the new admin's email). Names
// the acting admin's Cognito sub (finding f-7f03f151).
function logAndReturn(event, response) {
  logResponse(event, response, { actorSub: adminSubFromEvent(event) });
  return response;
}
