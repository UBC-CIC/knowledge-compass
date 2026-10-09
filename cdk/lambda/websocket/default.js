const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");
const jwt = require("jsonwebtoken");

const secretsManager = new SecretsManagerClient();
let cachedSecret;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The verified user id of a message's access token, or null.
 *
 * $connect only proves the socket was opened with some valid token, and that
 * token is not visible here, so each generate_text message carries the
 * current access token. Only tokens bound to a user (issued for a
 * credential) are accepted; text generation trusts no other user id.
 */
async function messageUserId(token) {
  if (typeof token !== "string" || !token) return null;
  if (!cachedSecret || Date.now() > cacheExpiry) {
    const response = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
    );
    cachedSecret = JSON.parse(response.SecretString).jwtSecret;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
  }
  try {
    const decoded = jwt.verify(token, cachedSecret, { algorithms: ["HS256"] });
    if (decoded.typ === "credential") return null;
    return typeof decoded.sub === "string" && UUID_REGEX.test(decoded.sub) ? decoded.sub : null;
  } catch {
    return null;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validateUUID = (value, fieldName = "id") => {
  if (!value || typeof value !== "string") return { valid: false, error: `${fieldName} is required` };
  if (!UUID_REGEX.test(value.trim())) return { valid: false, error: `${fieldName} must be a valid UUID` };
  return { valid: true };
};

const sanitizeString = (value, maxLength = 10000) => {
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

const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please refresh the page and try again.";

exports.handler = async (event) => {
  console.log("WebSocket message received:", {
    connectionId: event.requestContext.connectionId,
    routeKey: event.requestContext.routeKey,
    // Omit body to avoid logging sensitive data like user_id and chat_session_id
    timestamp: new Date().toISOString(),
  });

  try {
    const body = JSON.parse(event.body);
    const { action, query, chat_session_id, user_id, is_intro_message, token } = body;

    if (action === "generate_text") {
      // Validate inputs before invoking text generation Lambda
      const sanitizedQuery = sanitizeString(query, 10000);
      if (!sanitizedQuery) {
        return { statusCode: 400, body: JSON.stringify({ error: "query is required and must be a non-empty string" }) };
      }

      const sessionValidation = validateUUID(chat_session_id, "chat_session_id");
      if (!sessionValidation.valid) {
        return { statusCode: 400, body: JSON.stringify({ error: sessionValidation.error }) };
      }

      const callerUserId = await messageUserId(token);
      if (!callerUserId) {
        await sendErrorEvent(event, "A valid user session token is required", SESSION_EXPIRED_MESSAGE);
        return { statusCode: 401, body: JSON.stringify({ error: "A valid user session token is required" }) };
      }
      // Older clients still send user_id; it must name the token's user.
      if (user_id !== undefined && user_id !== null && user_id !== callerUserId) {
        await sendErrorEvent(event, "user_id does not match the session token", SESSION_EXPIRED_MESSAGE);
        return { statusCode: 403, body: JSON.stringify({ error: "user_id does not match the session token" }) };
      }

      // Invoke the text generation Lambda function. The verified user goes in
      // requestContext.authorizer, matching what API Gateway's user authorizer
      // gives the REST text_generation route; main.py trusts only that.
      const textGenPayload = {
        pathParameters: {
          id: chat_session_id,
        },
        body: JSON.stringify({
          query: sanitizedQuery,
          is_intro_message: is_intro_message
        }),
        requestContext: {
          connectionId: event.requestContext.connectionId,
          domainName: event.requestContext.domainName,
          stage: event.requestContext.stage,
          authorizer: { userId: callerUserId },
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

      console.log("Text generation function invoked successfully:", result);

      return { statusCode: 200 };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Unknown action" }),
    };
  } catch (error) {
    console.error("Error processing WebSocket message:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
