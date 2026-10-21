/**
 * connectionId -> verified anonymous user id, in the DynamoDB table named by
 * CONNECTIONS_TABLE_NAME. $connect writes it, $default reads it on every frame,
 * $disconnect deletes it. Items expire through TTL (expiresAt) a little after
 * API Gateway's 2-hour connection limit, so a live connection's record is
 * never missing. Fails closed when the table name is not configured.
 *
 * The same item carries a fixed-window generate_text frame counter for
 * $default (rlWindow = window number, rlCount = frames in it); see
 * consumeGenerateAllowance. WAFv2 cannot attach to WebSocket APIs, so this is
 * the per-connection rate limit.
 */

const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} = require("@aws-sdk/client-dynamodb");

// 2 h API Gateway maximum connection duration + 5 min margin.
const RECORD_TTL_SECONDS = 2 * 60 * 60 + 5 * 60;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dynamo = new DynamoDBClient({});

function tableName() {
  const name = process.env.CONNECTIONS_TABLE_NAME;
  if (!name) throw new Error("CONNECTIONS_TABLE_NAME is not configured");
  return name;
}

/** Bind `connectionId` to `userId`. Throws on any error, including an existing record. */
async function putConnection(connectionId, userId, nowMs = Date.now()) {
  await dynamo.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: {
        connectionId: { S: connectionId },
        userId: { S: userId },
        expiresAt: { N: String(Math.floor(nowMs / 1000) + RECORD_TTL_SECONDS) },
        connectedAt: { S: new Date(nowMs).toISOString() },
      },
      ConditionExpression: "attribute_not_exists(connectionId)",
    })
  );
}

/**
 * The user id bound to `connectionId`, or null when there is no (valid) record.
 * Consistent read: the first frame can arrive milliseconds after $connect.
 */
async function getConnectionUserId(connectionId) {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { connectionId: { S: connectionId } },
      ConsistentRead: true,
    })
  );
  const userId = result?.Item?.userId?.S;
  return typeof userId === "string" && UUID_REGEX.test(userId) ? userId : null;
}

/** Remove the binding for `connectionId`. Throws on error. */
async function deleteConnection(connectionId) {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: tableName(),
      Key: { connectionId: { S: connectionId } },
    })
  );
}

/** Default generate_text frames allowed per connection per window. */
const RATE_LIMIT_DEFAULTS = Object.freeze({ limit: 10, windowSeconds: 60 });

/** Positive integer from `value`, else `fallback` (never "unlimited"). */
function positiveInt(value, fallback) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Limiter config from WS_GENERATE_RATE_LIMIT / WS_GENERATE_RATE_WINDOW_SECONDS. */
function rateLimitConfig(env = process.env) {
  return {
    limit: positiveInt(env.WS_GENERATE_RATE_LIMIT, RATE_LIMIT_DEFAULTS.limit),
    windowSeconds: positiveInt(env.WS_GENERATE_RATE_WINDOW_SECONDS, RATE_LIMIT_DEFAULTS.windowSeconds),
  };
}

const isConditionalCheckFailed = (err) => err?.name === "ConditionalCheckFailedException";

/**
 * Count one generate_text frame against `connectionId`'s fixed window. Returns
 * true when allowed, false when the window is full or the record is gone, and
 * throws on any other DynamoDB error. Every update is conditioned on
 * attribute_exists(connectionId), so it never creates a record.
 */
async function consumeGenerateAllowance(connectionId, { limit, windowSeconds }, nowMs = Date.now()) {
  const TableName = tableName();
  const Key = { connectionId: { S: connectionId } };
  const window = String(Math.floor(nowMs / 1000 / windowSeconds));

  const increment = () =>
    dynamo.send(
      new UpdateItemCommand({
        TableName,
        Key,
        UpdateExpression: "ADD rlCount :one",
        ConditionExpression: "attribute_exists(connectionId) AND rlWindow = :w AND rlCount < :max",
        ExpressionAttributeValues: { ":one": { N: "1" }, ":w": { N: window }, ":max": { N: String(limit) } },
      })
    );
  const startWindow = () =>
    dynamo.send(
      new UpdateItemCommand({
        TableName,
        Key,
        UpdateExpression: "SET rlWindow = :w, rlCount = :one",
        ConditionExpression: "attribute_exists(connectionId) AND (attribute_not_exists(rlWindow) OR rlWindow < :w)",
        ExpressionAttributeValues: { ":one": { N: "1" }, ":w": { N: window } },
      })
    );

  // Retry the increment once: a concurrent frame may have just started this window.
  for (const attempt of [increment, startWindow, increment]) {
    try {
      await attempt();
      return true;
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }
  }
  return false;
}

module.exports = {
  putConnection,
  getConnectionUserId,
  deleteConnection,
  consumeGenerateAllowance,
  rateLimitConfig,
  RATE_LIMIT_DEFAULTS,
  RECORD_TTL_SECONDS,
};
