/**
 * Log helpers shared by the REST handlers.
 *
 * Rule: never log response or request bodies, headers, whole events, or
 * database error details. Bodies carry emails, chat transcripts, sources,
 * feedback comments and minted tokens; postgres.js errors copy server fields
 * such as `detail` ("Key (email)=(...) already exists.") and messages can
 * quote bound input.
 */

/**
 * Log one status line: { statusCode, resource, requestId }, plus the keys of
 * `extra` when given (adminHandler adds the acting admin's `actorSub`).
 */
function logResponse(event, response, extra = undefined) {
  // event.resource is the route template (e.g. /user/{user_id}), not the path.
  console.log({
    statusCode: response?.statusCode,
    resource: event?.resource,
    requestId: event?.requestContext?.requestId,
    ...(extra || {}),
  });
}

/** Database errors (postgres.js) may carry input values in message/detail. */
function isDatabaseError(error) {
  return error?.name === "PostgresError" || typeof error?.severity === "string";
}

/** Safe summary of an error: name and code, plus message for non-DB errors. */
function errorSummary(error) {
  const summary = { name: error?.name ?? "Error", code: error?.code };
  if (!isDatabaseError(error) && typeof error?.message === "string") {
    summary.message = error.message;
  }
  return summary;
}

module.exports = { logResponse, errorSummary };
