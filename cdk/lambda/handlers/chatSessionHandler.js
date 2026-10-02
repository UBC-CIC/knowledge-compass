const crypto = require("crypto");
const { getCorsHeaders } = require("./utils/cors.js");
const {
  validateUUID,
  validateEnum,
  sanitizeString,
} = require("./utils/validation.js");
const { toPublicMessage } = require("./utils/publicSources.js");
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
      console.error("Error initializing database connection:", error);
      throw error;
    }
  }
};

const createResponse = async (event) => ({
    statusCode: 200,
    headers: await getCorsHeaders(event),
    body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const FEEDBACK_RATINGS = ["up", "down"];
const FEEDBACK_COMMENT_MAX_LENGTH = 1000;

// Validates path/query ids and confirms the caller's user_id owns the session.
// Returns null on success, or { statusCode, error } to send back.
const checkFeedbackSessionOwnership = async (chatSessionId, userId) => {
  const sessionCheck = validateUUID(chatSessionId, "chat_session_id");
  if (!sessionCheck.valid) return { statusCode: 400, error: sessionCheck.error };

  const userCheck = validateUUID(userId, "user_id");
  if (!userCheck.valid) return { statusCode: 400, error: userCheck.error };

  const chatSession = await sqlConnection`
    SELECT id, user_id
    FROM chat_sessions
    WHERE id = ${chatSessionId}
  `;

  if (chatSession.length === 0) {
    return { statusCode: 404, error: "Chat session not found" };
  }

  if (chatSession[0].user_id !== userId) {
    return { statusCode: 403, error: "You can only give feedback on your own chat sessions" };
  }

  return null;
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", error);
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
        const userId = event.pathParameters?.user_id;

        if (!userId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "user_id is required" });
          break;
        }

        const sessions = await sqlConnection`
          SELECT id, user_id, title, created_at, last_active_at, metadata
          FROM chat_sessions
          WHERE user_id = ${userId}
          ORDER BY created_at DESC
        `;

        data = sessions;
        response.body = JSON.stringify(data);
        break;
      }

      case "POST /chat_sessions": {
        const body = parseBody(event.body);
        const userId = body.user_id || body.userId || body.user_sessions_session_id;

        if (!userId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "user_id is required" });
          break;
        }

        const title = body.title || null;
        const metadata = body.metadata || {};

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

        const inserted = await sqlConnection`
          INSERT INTO chat_sessions (
            id, user_id, title, created_at, last_active_at, metadata
          )
          VALUES (
            ${chatSessionId}, ${userId}, ${title}, ${now}, ${now}, ${metadata}
          )
          RETURNING id, user_id, title, created_at, last_active_at, metadata
        `;

        response.statusCode = 201;
        data = inserted[0];
        response.body = JSON.stringify(data);
        break;
      }

      case "PUT /chat_sessions/{chat_session_id}": {
        const chatSessionId = event.pathParameters?.chat_session_id;

        // Accept both names for compatibility while you transition
        const userId =
          event.queryStringParameters?.user_id ||
          event.queryStringParameters?.user_session_id;

        if (!chatSessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "chat_session_id is required" });
          break;
        }

        if (!userId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "user_id is required" });
          break;
        }

        const body = parseBody(event.body);
        const title = typeof body.title === "string" ? body.title.trim() : "";

        if (!title) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "title is required" });
          break;
        }

        const chatSession = await sqlConnection`
          SELECT id, user_id
          FROM chat_sessions
          WHERE id = ${chatSessionId}
        `;

        if (chatSession.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Chat session not found" });
          break;
        }

        if (chatSession[0].user_id !== userId) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "You can only rename your own chat sessions" });
          break;
        }

        const updated = await sqlConnection`
          UPDATE chat_sessions
          SET title = ${title}, last_active_at = NOW()
          WHERE id = ${chatSessionId}
          RETURNING id, user_id, title, created_at, last_active_at, metadata
        `;

        response.statusCode = 200;
        data = updated[0];
        response.body = JSON.stringify(data);
        break;
      }

      case "GET /chat_sessions/{chat_session_id}/chat_history": {
        const chatSessionId = event.pathParameters?.chat_session_id;
        const authenticatedUserId = event?.requestContext?.authorizer?.userId;

        if (!chatSessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "chat_session_id is required" });
          break;
        }

        if (!authenticatedUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Authentication required" });
          break;
        }

        const chatSessionResult = await sqlConnection`
          SELECT id, user_id
          FROM chat_sessions
          WHERE id = ${chatSessionId}
        `;

        if (chatSessionResult.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Chat session not found" });
          break;
        }

        // Ownership validation (mandatory)
        const ownerId = chatSessionResult[0].user_id;
        if (ownerId !== authenticatedUserId) {
          response.statusCode = 403;
          response.body = JSON.stringify({
            error: "Access denied",
            message: "You do not have permission to access this chat session",
          });
          break;
        }

        // Fetch messages
        const messages = await sqlConnection`
          SELECT id, chat_session_id, sender, content, sources, created_at
          FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}
          ORDER BY created_at ASC, id ASC
        `;

        data = {
          chat_session_id: chatSessionResult[0].id,
          messages: messages.map(toPublicMessage),
        };

        response.statusCode = 200;
        response.body = JSON.stringify(data);
        break;
      }

      case "DELETE /chat_sessions/{chat_session_id}": {
        const chatSessionId = event.pathParameters?.chat_session_id;

        // Accept both names for compatibility while you transition
        const userId =
          event.queryStringParameters?.user_id ||
          event.queryStringParameters?.user_session_id;

        if (!chatSessionId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "chat_session_id is required" });
          break;
        }

        if (!userId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "user_id is required" });
          break;
        }

        // Verify the chat session exists and belongs to the user
        const chatSession = await sqlConnection`
          SELECT id, user_id
          FROM chat_sessions
          WHERE id = ${chatSessionId}
        `;

        if (chatSession.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Chat session not found" });
          break;
        }

        if (chatSession[0].user_id !== userId) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "You can only delete your own chat sessions" });
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
        const userId = event.queryStringParameters?.user_id;

        const ownershipError = await checkFeedbackSessionOwnership(chatSessionId, userId);
        if (ownershipError) {
          response.statusCode = ownershipError.statusCode;
          response.body = JSON.stringify({ error: ownershipError.error });
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
        const userId = event.queryStringParameters?.user_id;

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

        const ownershipError = await checkFeedbackSessionOwnership(chatSessionId, userId);
        if (ownershipError) {
          response.statusCode = ownershipError.statusCode;
          response.body = JSON.stringify({ error: ownershipError.error });
          break;
        }

        // One feedback row per session; later submissions replace the rating
        // and comment so users can change their mind.
        const saved = await sqlConnection`
          INSERT INTO session_feedback (chat_session_id, rating, comment)
          VALUES (${chatSessionId}, ${body.rating}, ${comment})
          ON CONFLICT (chat_session_id) DO UPDATE SET
            rating = EXCLUDED.rating,
            comment = EXCLUDED.comment,
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

  // Feedback responses can contain the user's free-text comment; log status only.
  if (event.resource === "/chat_sessions/{chat_session_id}/feedback") {
    console.log({ statusCode: response.statusCode, resource: event.resource });
  } else {
    console.log(response);
  }
  return response;
};