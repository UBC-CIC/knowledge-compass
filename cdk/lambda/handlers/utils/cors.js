const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

let cachedAllowedOrigins = null;

// Every failure path yields an empty list, which blocks cross-origin reads.
// A wildcard is never honoured, even if someone puts "*" in the parameter.
const getAllowedOrigins = async () => {
  if (cachedAllowedOrigins) return cachedAllowedOrigins;
  const paramName = process.env.ALLOWED_ORIGIN_PARAM;
  if (!paramName) {
    console.error("CRITICAL: ALLOWED_ORIGIN_PARAM is not set — blocking all cross-origin requests");
    return [];
  }
  try {
    const ssm = new SSMClient();
    const command = new GetParameterCommand({ Name: paramName });
    const response = await ssm.send(command);
    cachedAllowedOrigins = response.Parameter.Value.split(',')
      .map(s => s.trim().replace(/\/$/, ''))
      .filter(s => s && !s.includes("*"));
  } catch (error) {
    console.error("CRITICAL: Failed to fetch CORS origins from SSM — blocking all cross-origin requests:", error);
    // Do not cache — allow retry on next request once SSM recovers
    return [];
  }
  return cachedAllowedOrigins;
};

// `methods` is the comma-separated list of HTTP methods the calling function
// serves (OPTIONS is always added). Omitting it advertises OPTIONS only.
const getCorsHeaders = async (event, methods = "") => {
  const allowedOrigins = await getAllowedOrigins();
  const origin = event?.headers?.origin || event?.headers?.Origin;
  const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : "";

  return {
    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": methods ? `${methods},OPTIONS` : "OPTIONS",
  };
};

module.exports = { getCorsHeaders };
