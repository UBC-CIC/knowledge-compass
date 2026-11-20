"use strict";

// API Gateway can return only one Access-Control-Allow-Origin value, and a
// wildcard would let any site read gateway error bodies. Take the first
// AllowedOrigins entry (the deployed SPA origin) and refuse anything else.
function gatewayAllowOrigin(raw) {
  const first = String(raw ?? "")
    .split(",")[0]
    .trim()
    .replace(/\/+$/, "");
  if (!first || first.includes("*")) {
    throw new Error("Refusing to publish a wildcard or empty API Gateway CORS origin");
  }
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(first)) {
    throw new Error("AllowedOrigins must start with a single http(s) origin and no path");
  }
  return first;
}

module.exports = { gatewayAllowOrigin };
