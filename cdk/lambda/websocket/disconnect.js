const { deleteConnection } = require("./connections.js");

exports.handler = async (event) => {
  console.log("WebSocket connection closed:", {
    connectionId: event.requestContext.connectionId,
    domainName: event.requestContext.domainName,
    stage: event.requestContext.stage,
    timestamp: new Date().toISOString(),
  });

  // Drop the connection's identity binding. $disconnect cannot be refused, so
  // a failure is only logged; the record's TTL removes it later.
  try {
    await deleteConnection(event.requestContext.connectionId);
  } catch (err) {
    console.error("WebSocket disconnect: failed to delete connection record", {
      connectionId: event.requestContext.connectionId,
      error: err?.name,
    });
  }

  return { statusCode: 200 };
};
