/**
 * Per-IP rate limits for the WebSocket API. WAFv2 cannot attach to a WebSocket
 * API, so $connect (every handshake) and $default (every generate_text frame)
 * count the client IP here, in the same DynamoDB table and fixed-window shape
 * as the per-user limit (connections.js consumeKeyedAllowance).
 *
 * The IP comes from requestContext.identity.sourceIp, which API Gateway sets
 * from the TCP connection; a client cannot choose it with a header. IPv6
 * addresses are counted per /64 prefix, because one host can usually rotate
 * through its whole /64. IPv4-mapped IPv6 addresses count as the IPv4 address.
 *
 * The IP is personal information, so it is never stored or logged. The
 * counter key is an HMAC-SHA256 of the address (or /64 prefix) under a key in
 * Secrets Manager (WS_IP_HASH_SECRET, field ipHashKey); without that key the
 * table cannot be mapped back to addresses. Fails closed: a missing secret,
 * a missing source IP or a DynamoDB fault throws, and callers refuse.
 */

const crypto = require("crypto");
const net = require("net");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { consumeKeyedAllowance, positiveInt } = require("./connections.js");

/** Defaults; api-stack.ts sets the same values through the environment. */
const IP_RATE_LIMIT_DEFAULTS = Object.freeze({ connect: 30, generate: 30, windowSeconds: 60 });
const CACHE_TTL_MS = 5 * 60 * 1000;

const secretsManager = new SecretsManagerClient();
let cachedKey;
let cachedAt = 0;

/** Limits from WS_IP_CONNECT_RATE_LIMIT / WS_IP_GENERATE_RATE_LIMIT / WS_IP_RATE_WINDOW_SECONDS. */
function ipRateLimitConfig(env = process.env) {
  const windowSeconds = positiveInt(env.WS_IP_RATE_WINDOW_SECONDS, IP_RATE_LIMIT_DEFAULTS.windowSeconds);
  return {
    connect: { limit: positiveInt(env.WS_IP_CONNECT_RATE_LIMIT, IP_RATE_LIMIT_DEFAULTS.connect), windowSeconds },
    generate: { limit: positiveInt(env.WS_IP_GENERATE_RATE_LIMIT, IP_RATE_LIMIT_DEFAULTS.generate), windowSeconds },
  };
}

/**
 * The bucket an address is counted in: "4:<ipv4>" or "6:<first four hextets>/64".
 * Null when `ip` is not an IP address.
 */
function ipBucket(ip) {
  if (typeof ip !== "string") return null;
  const value = ip.trim().toLowerCase();
  if (net.isIPv4(value)) return `4:${value}`;
  if (!net.isIPv6(value)) return null;

  let addr = value.split("%")[0];
  // Dotted IPv4 tail (::ffff:1.2.3.4 or other embedded forms).
  const tail = addr.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const octets = tail[2].split(".").map(Number);
    addr = `${tail[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  let hextets;
  if (addr.includes("::")) {
    const [head, rest] = addr.split("::");
    const left = head ? head.split(":") : [];
    const right = rest ? rest.split(":") : [];
    hextets = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  } else {
    hextets = addr.split(":");
  }
  if (hextets.length !== 8) return null;
  const parsed = hextets.map((h) => Number.parseInt(h, 16));
  // IPv4-mapped (::ffff:0:0/96), in dotted or hex form, counts as the IPv4 address.
  if (parsed.slice(0, 5).every((h) => h === 0) && parsed[5] === 0xffff) {
    return `4:${parsed[6] >> 8}.${parsed[6] & 0xff}.${parsed[7] >> 8}.${parsed[7] & 0xff}`;
  }
  return `6:${parsed.slice(0, 4).map((h) => h.toString(16)).join(":")}::/64`;
}

async function hashKey() {
  if (cachedKey && Date.now() - cachedAt < CACHE_TTL_MS) return cachedKey;
  const secretId = process.env.WS_IP_HASH_SECRET;
  if (!secretId) throw new Error("WS_IP_HASH_SECRET is not configured");
  const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  const key = JSON.parse(response.SecretString)?.ipHashKey;
  if (typeof key !== "string" || key.length < 32) throw new Error("IP hash key is not configured");
  cachedKey = key;
  cachedAt = Date.now();
  return key;
}

/** The source IP API Gateway recorded for this WebSocket event, or undefined. */
function sourceIpOf(event) {
  return event?.requestContext?.identity?.sourceIp;
}

/**
 * Count one event for `scope` ("connect" or "generate") against the caller's
 * IP window. Returns true when allowed, false when the window is full. Throws
 * when the source IP is missing or invalid, the key cannot be read, or
 * DynamoDB fails.
 */
async function consumeIpAllowance(event, scope, limits, nowMs = Date.now()) {
  if (scope !== "connect" && scope !== "generate") throw new Error("invalid IP limit scope");
  const bucket = ipBucket(sourceIpOf(event));
  if (!bucket) throw new Error("source IP is unavailable");
  const digest = crypto.createHmac("sha256", await hashKey()).update(bucket).digest("base64url");
  return consumeKeyedAllowance(`ip#${scope}#${digest}`, limits, nowMs);
}

module.exports = {
  IP_RATE_LIMIT_DEFAULTS,
  ipRateLimitConfig,
  ipBucket,
  consumeIpAllowance,
};
