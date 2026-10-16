/**
 * connectionId -> verified anonymous user id, in the DynamoDB table named by
 * CONNECTIONS_TABLE_NAME. $connect writes it, $default reads it on every frame,
 * $disconnect deletes it. Items expire through TTL (expiresAt) a little after
 * API Gateway's 2-hour connection limit, so a live connection's record is
 * never missing. Fails closed when the table name is not configured.
 */

const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
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

module.exports = { putConnection, getConnectionUserId, deleteConnection, RECORD_TTL_SECONDS };
