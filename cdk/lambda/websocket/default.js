/**
 * WebSocket $default: every frame acts as the user the connection is bound to.
 *
 * $connect verified an access token and stored connectionId -> userId
 * (connections.js). Each frame first looks that binding up; a connection with
 * no record is refused and closed so the client reconnects (or falls back to
 * HTTP). Each generate_text frame also carries the current access token, which
 * must be valid and name the bound user, so freshness and revocation still
 * apply per frame. Text generation receives only the bound user id; a
 * frame-supplied user_id is checked against it and never forwarded.
 * generate_text queries are truncated to system_settings.max_characters_per_user_message
 * (messageLimit.js), which falls back to 2000 when that read misses.
 *
 * generate_text frames are rate limited per connection (fixed window,
 * WS_GENERATE_RATE_LIMIT per WS_GENERATE_RATE_WINDOW_SECONDS) before any other
 * work; over the limit the frame gets a RATE_LIMITED error event and nothing is
 * invoked. A limiter fault fails closed. Pings are not counted.
 */

const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  DeleteConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");
const { verifyAccessToken } = require("./accessToken.js");
const {
  getConnectionUserId, consumeGenerateAllowance, consumeUserGenerateAllowance, rateLimitConfig,
} = require("./connections.js");
const messageLimit = require("./messageLimit.js");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validateUUID = (value, fieldName = "id") => {
  if (!value || typeof value !== "string") return { valid: false, error: `${fieldName} is required` };
  if (!UUID_REGEX.test(value.trim())) return { valid: false, error: `${fieldName} must be a valid UUID` };
  return { valid: true };
};

const sanitizeString = (value, maxLength = messageLimit.DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, maxLength);
};

const lambda = new LambdaClient({});

/** Best-effort terminal "error" event so the client stops waiting on a reply. */
async function sendErrorEvent(event, error, message) {
  const { connectionId, domainName, stage } = event.requestContext || {};
  if (!connectionId || !domainName || !stage) return;
  try {
    const client = new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ type: "error", error, message }),
      })
    );
  } catch (err) {
    console.error("Failed to post error event to WebSocket connection:", err?.name);
  }
}

/** Best effort: drop a socket that has no verified binding so the client reconnects. */
async function closeConnection(event) {
  const { connectionId, domainName, stage } = event.requestContext || {};
  if (!connectionId || !domainName || !stage) return;
  try {
    const client = new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
    await client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
  } catch (err) {
    console.error("Failed to close unbound WebSocket connection:", err?.name);
  }
}

const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please refresh the page and try again.";
const GENERIC_MESSAGE = "Sorry, something went wrong. Please try again.";
const RECONNECT_MESSAGE = "Your connection was refreshed. Please send your message again.";
const RATE_LIMITED_MESSAGE = "You're sending messages a little quickly. Please wait a moment, then try again.";

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  console.log("WebSocket message received:", {
    connectionId,
    routeKey: event.requestContext.routeKey,
    // Omit body to avoid logging sensitive data like user_id and chat_session_id
    timestamp: new Date().toISOString(),
  });

  let boundUserId;
  try {
    boundUserId = await getConnectionUserId(connectionId);
  } catch (err) {
    // The binding may well exist; do not close the socket on a lookup fault.
    console.error("WebSocket connection lookup failed", { connectionId, error: err?.name });
    await sendErrorEvent(event, "Internal server error", GENERIC_MESSAGE);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal server error" }) };
  }

  if (!boundUserId) {
    // No verified binding (opened before this check existed, or the record is
    // gone). Tell a waiting generate_text caller, then close the socket for any
    // frame (pings and unparseable bodies too) so the client reconnects.
    let action;
    try {
      action = JSON.parse(event.body)?.action;
    } catch {
      action = undefined;
    }
    if (action === "generate_text") {
      await sendErrorEvent(event, "CONNECTION_NOT_AUTHORIZED", RECONNECT_MESSAGE);
    }
    await closeConnection(event);
    console.warn("WebSocket frame rejected: no connection record", { connectionId });
    return { statusCode: 401, body: JSON.stringify({ error: "CONNECTION_NOT_AUTHORIZED" }) };
  }

  try {
    const body = JSON.parse(event.body);
    // Any client-sent is_intro_message is ignored: the guardrail always runs.
    const { action, query, chat_session_id, user_id, token } = body;

    if (action === "generate_text") {
      // Count every generate_text frame (valid or not) before doing any work.
      // Both windows must allow it: this socket's, and the bound guest's across
      // all of their sockets, so opening more connections buys no allowance.
      let allowed;
      try {
        const limits = rateLimitConfig();
        allowed =
          (await consumeGenerateAllowance(connectionId, limits)) &&
          (await consumeUserGenerateAllowance(boundUserId, limits));
      } catch (err) {
        console.error("WebSocket rate limit check failed", { connectionId, error: err?.name });
        await sendErrorEvent(event, "Internal server error", GENERIC_MESSAGE);
        return { statusCode: 500, body: JSON.stringify({ error: "Internal server error" }) };
      }
      if (!allowed) {
        console.warn("WebSocket frame rejected: rate limited", { connectionId });
        await sendErrorEvent(event, "RATE_LIMITED", RATE_LIMITED_MESSAGE);
        return { statusCode: 429, body: JSON.stringify({ error: "RATE_LIMITED" }) };
      }

      if (typeof query !== "string" || query.trim().length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: "query is required and must be a non-empty string" }) };
      }

      const sessionValidation = validateUUID(chat_session_id, "chat_session_id");
      if (!sessionValidation.valid) {
        return { statusCode: 400, body: JSON.stringify({ error: sessionValidation.error }) };
      }

      const callerUserId = await verifyAccessToken(token);
      if (!callerUserId) {
        await sendErrorEvent(event, "A valid user session token is required", SESSION_EXPIRED_MESSAGE);
        return { statusCode: 401, body: JSON.stringify({ error: "A valid user session token is required" }) };
      }
      // The frame token must name the user this connection was bound to.
      if (callerUserId !== boundUserId) {
        console.warn("WebSocket frame rejected: token user differs from connection", { connectionId });
        await sendErrorEvent(event, "CONNECTION_USER_MISMATCH", RECONNECT_MESSAGE);
        return { statusCode: 403, body: JSON.stringify({ error: "CONNECTION_USER_MISMATCH" }) };
      }
      // Older clients still send user_id; it must name the bound user.
      if (user_id !== undefined && user_id !== null && user_id !== boundUserId) {
        console.warn("WebSocket frame rejected: user_id differs from connection", { connectionId });
        await sendErrorEvent(event, "user_id does not match the session token", SESSION_EXPIRED_MESSAGE);
        return { statusCode: 403, body: JSON.stringify({ error: "user_id does not match the session token" }) };
      }

      // Truncate to the administrator's per-message cap (system_settings), not a
      // hard-coded length. Read it only after the frame is authenticated. A
      // missed read uses the conservative default.
      const maxCharacters = await messageLimit.getMaxCharactersPerUserMessage();
      const sanitizedQuery = sanitizeString(query, maxCharacters);
      if (!sanitizedQuery) {
        return { statusCode: 400, body: JSON.stringify({ error: "query is required and must be a non-empty string" }) };
      }

      // Invoke the text generation Lambda function. The bound user goes in
      // requestContext.authorizer, matching what API Gateway's user authorizer
      // gives the REST text_generation route; main.py trusts only that.
      const textGenPayload = {
        pathParameters: {
          id: chat_session_id,
        },
        body: JSON.stringify({
          query: sanitizedQuery,
        }),
        requestContext: {
          connectionId: event.requestContext.connectionId,
          domainName: event.requestContext.domainName,
          stage: event.requestContext.stage,
          authorizer: { userId: boundUserId },
        },
      };

      // Do not log the payload: it contains the user's message and identifiers.
      console.log("Invoking text generation function", {
        connectionId: event.requestContext.connectionId,
      });

      const result = await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.TEXT_GEN_FUNCTION_NAME,
          InvocationType: "Event", // Asynchronous invocation
          Payload: JSON.stringify(textGenPayload),
        })
      );

      console.log("Text generation function invoked successfully:", {
        connectionId,
        statusCode: result?.StatusCode,
      });

      return { statusCode: 200 };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Unknown action" }),
    };
  } catch (error) {
    // Name only: a JSON.parse SyntaxError message quotes part of the frame body.
    console.error("Error processing WebSocket message", { connectionId, error: error?.name });
    await sendErrorEvent(event, "Internal server error", GENERIC_MESSAGE);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
