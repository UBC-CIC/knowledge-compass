const postgres = require("postgres");
const { getCorsHeaders } = require("./utils/cors.js");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const crypto = require("crypto");
const { sanitizeString, validateUUID } = require("./utils/validation.js");
const { toPublicMessage } = require("./utils/publicSources.js");
const { resolveCaller } = require("./utils/callerIdentity.js");
const {
  exchangeCredential,
  issueAccessTokenWithId,
  issueUserCredential,
} = require("./utils/userCredential.js");
const { logResponse, errorSummary } = require("./utils/logging.js");

/** Bearer value of the Authorization header, or null. */
const bearerToken = (event) => {
  const headers = event?.headers || {};
  const value = headers.Authorization || headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim() || null;
};

/**
 * One structured line per issued access token (finding f-0d57a9d0), so
 * anonymous-tier abuse can be traced: the token's jti, the bound guest id
 * (a random UUID, null for anonymous tokens), source IP (already in the API
 * access log under the same request id), user agent and request id. Never
 * the token or the credential.
 */
const logTokenIssued = (event, { tokenId, userId, credentialRotated }) => {
  const identity = event?.requestContext?.identity || {};
  const headers = event?.headers || {};
  const userAgent = String(identity.userAgent ?? headers["User-Agent"] ?? headers["user-agent"] ?? "").slice(0, 200);
  console.log(
    JSON.stringify({
      audit: "access_token_issued",
      tokenId,
      bound: Boolean(userId),
      userId: userId || null,
      credentialRotated,
      requestId: event?.requestContext?.requestId ?? null,
      sourceIp: identity.sourceIp ?? null,
      userAgent: userAgent || null,
    })
  );
};

// Reply with a resolveCaller() failure.
const rejectCaller = (response, caller) => {
  response.statusCode = caller.statusCode;
  response.body = JSON.stringify({ error: caller.error });
};

let sqlConnection;
const secretsManager = new SecretsManagerClient();

const initConnection = async () => {
  if (!sqlConnection) {
    try {
      const getSecretValueCommand = new GetSecretValueCommand({
        SecretId: process.env.SM_DB_CREDENTIALS,
      });
      const secretResponse = await secretsManager.send(getSecretValueCommand);
      const credentials = JSON.parse(secretResponse.SecretString);

      const connectionConfig = {
        host: process.env.RDS_PROXY_ENDPOINT,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        database: credentials.dbname,
        ssl: { rejectUnauthorized: true },
      };

      sqlConnection = postgres(connectionConfig);
      await sqlConnection`SELECT 1`;
      console.log("Database connection initialized successfully");
    } catch (error) {
      console.error("Error initializing database connection:", errorSummary(error));
      throw error;
    }
  }
};

// HTTP methods this function serves (OpenAPI_Swagger_Definition.yaml).
const SERVED_METHODS = "GET,POST";

const createResponse = async (event) => ({
    statusCode: 200,
    headers: await getCorsHeaders(event, SERVED_METHODS),
    body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", errorSummary(error));
  response.body = JSON.stringify({ error: "Internal server error" });
};

exports.handler = async (event) => {
  const response = await createResponse(event);
  let data;

  try {
    const pathData = event.httpMethod + " " + event.resource;

    // Unauthenticated: anyone may get an anonymous token; a credential from
    // POST /user gets a token bound to its user (see utils/userCredential.js).
    if (pathData === "GET /user/publicToken") {
      const credential = bearerToken(event);
      let issued = null;
      if (!credential) {
        const { token, tokenId } = await issueAccessTokenWithId(null);
        issued = { tokenId, userId: null, credentialRotated: false };
        response.body = JSON.stringify({ token });
      } else {
        await initConnection();
        const exchanged = await exchangeCredential(sqlConnection, credential);
        if (exchanged) {
          // tokenId/userId are for the issuance log only; the response
          // contract stays { token, credential? }.
          const { tokenId, userId, ...payload } = exchanged;
          issued = { tokenId, userId, credentialRotated: Boolean(payload.credential) };
          response.body = JSON.stringify(payload);
        } else {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "invalid_credential" });
        }
      }
      // The body holds the minted token; log status only.
      logResponse(event, response);
      if (issued) logTokenIssued(event, issued);
      return response;
    }

    // Ensure connection is initialized before proceeding
    await initConnection();

    switch (pathData) {
      case "POST /user": {
        const body = parseBody(event.body);

        // Default role is student
        const role = "student";
        const userId = crypto.randomUUID();
        const displayName = sanitizeString(body.display_name ?? body.displayName, 64);

        const now = new Date();

        // Create a guest row. body.email and body.metadata are never read: a
        // guest holds no address and no client-chosen metadata (finding F16;
        // staff identity is keyed on the Cognito sub, see
        // authorization/staffIdentity.js). Migration 046 enforces the email part.
        const result = await sqlConnection`
          INSERT INTO users (
            id, display_name, role, identity_source,
            created_at, last_seen_at
          )
          VALUES (
            ${userId}, ${displayName}, ${role}, 'guest',
            ${now}, ${now}
          )
          RETURNING
            id, email, display_name, role,
            created_at, last_seen_at, metadata, credential_version
        `;

        const row = result[0];

        data = {
          userId: row.id,
          // The browser stores this and exchanges it at /user/publicToken
          // for access tokens bound to this user.
          credential: await issueUserCredential(row.id, row.credential_version),
          email: row.email,
          display_name: row.display_name,
          role: row.role,
          created_at: row.created_at,
          last_seen_at: row.last_seen_at,
          metadata: row.metadata,
        };

        response.body = JSON.stringify(data);
        break;
      }

      case "GET /user/{user_id}": {
        const userId = event.pathParameters?.user_id;
        const userIdValidation = validateUUID(userId, "user_id");
        if (!userIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: userIdValidation.error });
          break;
        }
        const caller = resolveCaller(event, userId);
        if (caller.error) {
          rejectCaller(response, caller);
          break;
        }

        const user = await sqlConnection`
          SELECT id, email, display_name, role, created_at, last_seen_at,
                messages_sent, messages_window_started_at, metadata
          FROM users
          WHERE id = ${userId}
        `;

        if (user.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        // update last_seen_at
        await sqlConnection`
          UPDATE users SET last_seen_at = NOW() WHERE id = ${userId}
        `;

        response.body = JSON.stringify(user[0]);
        break;
      }

      case "GET /user/{user_id}/chat_sessions/{chat_session_id}/chat_history": {
        const userId = event.pathParameters?.user_id;
        const chatSessionId = event.pathParameters?.chat_session_id;

        const userIdValidation = validateUUID(userId, "user_id");
        if (!userIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: userIdValidation.error });
          break;
        }
        const sessionIdValidation = validateUUID(chatSessionId, "chat_session_id");
        if (!sessionIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: sessionIdValidation.error });
          break;
        }
        const caller = resolveCaller(event, userId);
        if (caller.error) {
          rejectCaller(response, caller);
          break;
        }

        // Validate user exists (optional but nice)
        const userExists = await sqlConnection`
          SELECT id FROM users WHERE id = ${userId}
        `;
        if (userExists.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        // The session must belong to the caller. Missing and foreign sessions
        // get the same 404, so no guest can probe another family's session ids.
        const chatSession = await sqlConnection`
          SELECT id
          FROM chat_sessions
          WHERE id = ${chatSessionId} AND user_id = ${userId}
        `;
        if (chatSession.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Chat session not found" });
          break;
        }

        const limit = Math.min(parseInt(event.queryStringParameters?.limit) || 200, 1000);
        const offset = parseInt(event.queryStringParameters?.offset) || 0;

        const rows = await sqlConnection`
          SELECT
            id,
            chat_session_id,
            sender,
            content,
            sources,
            warning,
            created_at,
            COUNT(*) OVER() as total_count
          FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}
          ORDER BY created_at ASC, id ASC
          LIMIT ${limit} OFFSET ${offset}
        `;

        const total = rows.length > 0 ? parseInt(rows[0].total_count) : 0;
        const messages = rows.map(({ total_count, ...msg }) => toPublicMessage(msg));

        data = {
          chat_session_id: chatSessionId,
          user_id: userId,
          messages,
          pagination: {
            limit,
            offset,
            total,
            hasMore: offset + limit < total,
          },
        };

        response.statusCode = 200;
        response.body = JSON.stringify(data);
        break;
      }

      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    handleError(error, response);
  }

  // Bodies hold the user's credential, email or chat history; log status only.
  logResponse(event, response);
  return response;
};
