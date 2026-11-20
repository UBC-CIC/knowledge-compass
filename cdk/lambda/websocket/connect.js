/**
 * WebSocket $connect: authenticate the handshake and bind the connection.
 *
 * The client offers `Sec-WebSocket-Protocol: kc.v1, <access token>` (browsers)
 * or sends `Authorization: Bearer <access token>` (other clients). Tokens in
 * the query string or body are never read, so credentials stay out of URLs
 * and access logs. A valid user-bound access token's `sub` is stored as
 * connectionId -> userId (connections.js); $default enforces that binding on
 * every frame. The route has no API Gateway authorizer by design (see the
 * comment on the $connect route in cdk/lib/api-stack.ts). Handshakes are
 * rate limited per client IP first (ipLimit.js); over the limit is 429.
 */

const { verifyAccessToken } = require("./accessToken.js");
const { putConnection } = require("./connections.js");
const { consumeIpAllowance, ipRateLimitConfig } = require("./ipLimit.js");

const SUBPROTOCOL = "kc.v1";

exports.handler = async (event) => {
  const connectionId = event.requestContext?.connectionId;
  const stage = event.requestContext?.stage;
  const timestamp = new Date().toISOString();
  // Reason codes only: never log headers, the token or its claims.
  const reject = (reason) => {
    console.warn("WebSocket connect rejected", { connectionId, stage, timestamp, reason });
    return { statusCode: 401, body: "Unauthorized" };
  };

  // Count every handshake against the caller's IP (ipLimit.js) before any other
  // work, so floods of bad or missing tokens are counted too. Fails closed.
  let allowed;
  try {
    allowed = await consumeIpAllowance(event, "connect", ipRateLimitConfig().connect);
  } catch (err) {
    console.error("WebSocket connect failed: IP rate limit check", { connectionId, error: err?.name });
    return { statusCode: 500, body: "Internal server error" };
  }
  if (!allowed) {
    console.warn("WebSocket connect rejected", { connectionId, stage, timestamp, reason: "ip_rate_limited" });
    return { statusCode: 429, body: "Too Many Requests" };
  }

  const extracted = extractToken(event);
  if (extracted.error) return reject(extracted.error);

  let userId;
  try {
    userId = await verifyAccessToken(extracted.token);
  } catch (err) {
    // Configuration or Secrets Manager fault: a server error, not a bad token.
    console.error("WebSocket connect failed: token verification", { connectionId, error: err?.name });
    return { statusCode: 500, body: "Internal server error" };
  }
  if (!userId) return reject("invalid_token");

  try {
    await putConnection(connectionId, userId);
  } catch (err) {
    console.error("WebSocket connect failed: connection store", { connectionId, error: err?.name });
    return { statusCode: 500, body: "Internal server error" };
  }

  console.log("WebSocket connection authorized", { connectionId, stage, timestamp });
  const response = { statusCode: 200 };
  // Browsers abort the handshake unless the server selects an offered protocol.
  if (extracted.viaSubprotocol) response.headers = { "Sec-WebSocket-Protocol": SUBPROTOCOL };
  return response;
};

function findHeader(headers, name) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/**
 * { token, viaSubprotocol } or { error: reason }. When Sec-WebSocket-Protocol
 * is present only it is used: exactly "kc.v1" once plus one non-empty token.
 */
function extractToken(event) {
  const headers = event.headers || {};

  const protocolHeader = findHeader(headers, "sec-websocket-protocol");
  if (protocolHeader !== undefined) {
    const entries = String(protocolHeader).split(",").map((entry) => entry.trim());
    const markers = entries.filter((entry) => entry === SUBPROTOCOL);
    const others = entries.filter((entry) => entry !== SUBPROTOCOL);
    if (markers.length !== 1 || others.length !== 1 || !others[0]) {
      return { error: "malformed_subprotocol" };
    }
    return { token: others[0], viaSubprotocol: true };
  }

  const authHeader = findHeader(headers, "authorization");
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token) return { token, viaSubprotocol: false };
  }

  return { error: "missing_token" };
}
