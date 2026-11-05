const crypto = require("crypto");
const { getCorsHeaders } = require("./utils/cors.js");
const {
  validateUUID,
  validateEnum,
  sanitizeString,
} = require("./utils/validation.js");
const { resolveCaller } = require("./utils/callerIdentity.js");
const { resolveEvalTag } = require("./utils/evalTag.js");
const { validateSessionMetadata } = require("./utils/sessionMetadata.js");
const { logResponse, errorSummary } = require("./utils/logging.js");
const postgres = require("postgres");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

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
const SERVED_METHODS = "DELETE,GET,POST,PUT";

const createResponse = async (event) => ({
    statusCode: 200,
    headers: await getCorsHeaders(event, SERVED_METHODS),
    body: "",
});

// A JSON object, or "Invalid JSON body" (400 at every call site). Literal
// null, arrays and scalars are refused too, so no route reads a property of a
// non-object (finding f-5290289f).
const parseBody = (body) => {
  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON body");
  return parsed;
};

// New chat sessions one user may create per UTC day (finding F19, decision
// D12). Counted at creation in user_daily_usage.sessions_created (migration
// 047), so deleting a session does not free a slot.
const DAILY_SESSION_LIMIT = 20;
const DAILY_SESSION_LIMIT_MESSAGE =
  "You've started the most new chats allowed for today. You can keep going in one of your existing chats, or start a new one tomorrow.";

// Start of the next UTC day, when the session count resets.
const nextUtcMidnight = (now) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

const FEEDBACK_RATINGS = ["up", "down"];
const FEEDBACK_COMMENT_MAX_LENGTH = 1000;
// chat_sessions.title is an unbounded varchar; the auto-titler writes at most
// 80 characters (textGeneration/helpers/chat.py). Guest titles are capped too,
// with room for a longer hand-written name (finding f-3406ec2a).
const TITLE_MAX_LENGTH = 120;

// The acting user always comes from the verified token (resolveCaller). A
// user_id the client still sends (query or body, for older clients) must match
// it; it is never trusted on its own.
const queryUserId = (event) =>
  event.queryStringParameters?.user_id || event.queryStringParameters?.user_session_id;

// Validates the session id and confirms `userId` (the token's user) owns it.
// Returns null on success, or { statusCode, error } to send back. A missing
// and a foreign session get the same 404, so no guest can tell whether
// another family's session id exists (as in textGeneration's
// session_security.py, finding f-c5ba1a1b).
const SESSION_NOT_FOUND = { statusCode: 404, error: "Chat session not found" };

const checkSessionOwnership = async (chatSessionId, userId) => {
  const sessionCheck = validateUUID(chatSessionId, "chat_session_id");
  if (!sessionCheck.valid) return { statusCode: 400, error: sessionCheck.error };

  const chatSession = await sqlConnection`
    SELECT id
    FROM chat_sessions
    WHERE id = ${chatSessionId} AND user_id = ${userId}
  `;

  return chatSession.length === 0 ? SESSION_NOT_FOUND : null;
};

const reject = (response, failure) => {
  response.statusCode = failure.statusCode;
  response.body = JSON.stringify({ error: failure.error });
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
    await initConnection();
    const pathData = event.httpMethod + " " + event.resource;

    switch (pathData) {
      case "GET /chat_sessions/user/{user_id}": {
        const caller = resolveCaller(event, event.pathParameters?.user_id);
        if (caller.error) {
          reject(response, caller);
          break;
        }

        // guide_state and routing.guide_section name the guide section in use;
        // they are admin-only (journeyPrompts.js feedbackCounts reads
        // routing.guide_section). Every guest projection below strips both
        // (finding f-d2560261).
        const sessions = await sqlConnection`
          SELECT id, user_id, title, created_at, last_active_at,
                 (metadata - 'guide_state') #- '{routing,guide_section}' AS metadata
          FROM chat_sessions
          WHERE user_id = ${caller.userId}
          ORDER BY created_at DESC
        `;

        data = sessions;
        response.body = JSON.stringify(data);
        break;
      }

      case "POST /chat_sessions": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }
        const claimedUserId = body.user_id || body.userId || body.user_sessions_session_id;
        const caller = resolveCaller(event, claimedUserId);
        if (caller.error) {
          reject(response, caller);
          break;
        }
        const userId = caller.userId;

        const title = sanitizeString(body.title, TITLE_MAX_LENGTH);

        // Server-authored keys (journey_state, guide_state, routing) reach the
        // model prompt, so clients may only set allow-listed keys.
        const metadataCheck = validateSessionMetadata(body.metadata);
        if (!metadataCheck.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: metadataCheck.error });
          break;
        }
        const metadata = metadataCheck.metadata;

        // Validate user exists
        const userExists = await sqlConnection`
          SELECT id FROM users WHERE id = ${userId}
        `;
        if (userExists.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        const now = new Date();

        const chatSessionId = crypto.randomUUID();

        // Evaluation-harness tag (top-level `eval`, never metadata). Only a
        // correctly signed tag for this user sets the server-only columns;
        // anything else creates a normal session (see utils/evalTag.js).
        const evalTag = await resolveEvalTag(body, userId);

        // Claim a daily session slot and create the session in one
        // transaction: the conditional upsert lets concurrent creates pass
        // only while the count stays within the limit, and a failed insert
        // rolls the claim back.
        const inserted = await sqlConnection.begin(async (tx) => {
          const [slot] = await tx`
            INSERT INTO user_daily_usage (user_id, usage_date, sessions_created, updated_at)
            VALUES (${userId}, (now() AT TIME ZONE 'UTC')::date, 1, now())
            ON CONFLICT (user_id, usage_date) DO UPDATE
               SET sessions_created = user_daily_usage.sessions_created + 1,
                   updated_at = now()
             WHERE user_daily_usage.sessions_created < ${DAILY_SESSION_LIMIT}
            RETURNING sessions_created
          `;
          if (!slot) return null;

          return evalTag
            ? await tx`
            INSERT INTO chat_sessions (
              id, user_id, title, created_at, last_active_at, metadata,
              eval_run_id, prompt_mode_override
            )
            VALUES (
              ${chatSessionId}, ${userId}, ${title}, ${now}, ${now}, ${metadata},
              ${evalTag.runId}, ${evalTag.mode}
            )
            RETURNING id, user_id, title, created_at, last_active_at,
                      (metadata - 'guide_state') #- '{routing,guide_section}' AS metadata
          `
            : await tx`
            INSERT INTO chat_sessions (
              id, user_id, title, created_at, last_active_at, metadata
            )
            VALUES (
              ${chatSessionId}, ${userId}, ${title}, ${now}, ${now}, ${metadata}
            )
            RETURNING id, user_id, title, created_at, last_active_at,
                      (metadata - 'guide_state') #- '{routing,guide_section}' AS metadata
          `;
        });

        if (!inserted) {
          response.statusCode = 429;
          response.body = JSON.stringify({
            error: "DAILY_SESSION_LIMIT_EXCEEDED",
            message: DAILY_SESSION_LIMIT_MESSAGE,
            session_usage: { limit: DAILY_SESSION_LIMIT, reset_at: nextUtcMidnight(now) },
          });
          break;
        }

        response.statusCode = 201;
        data = inserted[0];
        response.body = JSON.stringify(data);
        break;
      }

      case "PUT /chat_sessions/{chat_session_id}": {
        const chatSessionId = event.pathParameters?.chat_session_id;

        if (!chatSessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "chat_session_id is required" });
          break;
        }

        const caller = resolveCaller(event, queryUserId(event));
        if (caller.error) {
          reject(response, caller);
          break;
        }

        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }
        const title = sanitizeString(body.title, TITLE_MAX_LENGTH);

        if (!title) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "title is required" });
          break;
        }

        const ownershipError = await checkSessionOwnership(chatSessionId, caller.userId);
        if (ownershipError) {
          reject(response, ownershipError);
          break;
        }

        const updated = await sqlConnection`
          UPDATE chat_sessions
          SET title = ${title}, last_active_at = NOW()
          WHERE id = ${chatSessionId}
          RETURNING id, user_id, title, created_at, last_active_at,
                    (metadata - 'guide_state') #- '{routing,guide_section}' AS metadata
        `;

        response.statusCode = 200;
        data = updated[0];
        response.body = JSON.stringify(data);
        break;
      }

      case "DELETE /chat_sessions/{chat_session_id}": {
        const chatSessionId = event.pathParameters?.chat_session_id;

        if (!chatSessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "chat_session_id is required" });
          break;
        }

        const caller = resolveCaller(event, queryUserId(event));
        if (caller.error) {
          reject(response, caller);
          break;
        }

        const ownershipError = await checkSessionOwnership(chatSessionId, caller.userId);
        if (ownershipError) {
          reject(response, ownershipError);
          break;
        }

        // Delete children first if you DON'T have ON DELETE CASCADE
        await sqlConnection`
          DELETE FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}
        `;

        // Delete the chat session
        await sqlConnection`
          DELETE FROM chat_sessions
          WHERE id = ${chatSessionId}
        `;

        response.statusCode = 204;
        response.body = "";
        break;
      }

      case "GET /chat_sessions/{chat_session_id}/feedback": {
        const chatSessionId = event.pathParameters?.chat_session_id;

        const caller = resolveCaller(event, queryUserId(event));
        if (caller.error) {
          reject(response, caller);
          break;
        }

        const ownershipError = await checkSessionOwnership(chatSessionId, caller.userId);
        if (ownershipError) {
          reject(response, ownershipError);
          break;
        }

        const rows = await sqlConnection`
          SELECT rating, comment, updated_at
          FROM session_feedback
          WHERE chat_session_id = ${chatSessionId}
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({ feedback: rows[0] ?? null });
        break;
      }

      case "PUT /chat_sessions/{chat_session_id}/feedback": {
        const chatSessionId = event.pathParameters?.chat_session_id;

        const caller = resolveCaller(event, queryUserId(event));
        if (caller.error) {
          reject(response, caller);
          break;
        }

        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const ratingCheck = validateEnum(body.rating, FEEDBACK_RATINGS, "rating");
        if (!ratingCheck.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: ratingCheck.error });
          break;
        }

        if (body.comment !== undefined && body.comment !== null && typeof body.comment !== "string") {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "comment must be a string" });
          break;
        }
        const comment = sanitizeString(body.comment, FEEDBACK_COMMENT_MAX_LENGTH);

        const ownershipError = await checkSessionOwnership(chatSessionId, caller.userId);
        if (ownershipError) {
          reject(response, ownershipError);
          break;
        }

        // One feedback row per session; later submissions replace the rating
        // and comment so users can change their mind.
        // The widget sits under the latest finished reply, so link the
        // session's latest AI message (migration 030). Streamed replies only
        // have a client-side id, so the server resolves it here.
        const saved = await sqlConnection`
          INSERT INTO session_feedback (chat_session_id, rating, comment, chat_message_id)
          VALUES (
            ${chatSessionId},
            ${body.rating},
            ${comment},
            (SELECT cm.id FROM chat_messages cm
              WHERE cm.chat_session_id = ${chatSessionId} AND cm.sender = 'AI'
              ORDER BY cm.created_at DESC
              LIMIT 1)
          )
          ON CONFLICT (chat_session_id) DO UPDATE SET
            rating = EXCLUDED.rating,
            comment = EXCLUDED.comment,
            chat_message_id = COALESCE(EXCLUDED.chat_message_id, session_feedback.chat_message_id),
            -- An edit brings dismissed feedback back to the admin Recent list
            -- so the new text is seen; an admin's star is kept (migration 029).
            dismissed_at = NULL,
            updated_at = now()
          RETURNING rating, updated_at
        `;

        // The comment is intentionally not echoed back so it never appears in
        // response logs.
        response.statusCode = 200;
        response.body = JSON.stringify({
          rating: saved[0].rating,
          has_comment: comment !== null,
          updated_at: saved[0].updated_at,
        });
        break;
      }

      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    handleError(error, response);
  }

  // Bodies can hold transcripts, session titles, metadata and feedback
  // comments; log status only.
  logResponse(event, response);
  return response;
};
