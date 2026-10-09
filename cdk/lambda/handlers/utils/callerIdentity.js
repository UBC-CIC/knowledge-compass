/**
 * Caller identity for public user and session routes.
 *
 * The user authorizer (authorization/userAuthorizerFunction.js) puts the
 * verified token's `sub` in requestContext.authorizer.userId. Access tokens
 * only carry a `sub` when /user/publicToken was given that user's credential,
 * so this is the one user id a handler may trust. user_id values in the path,
 * query or body are only checked against it, never used on their own.
 */

const { validateUUID } = require("./validation.js");

/** The verified caller's user id, or null for anonymous tokens. */
function callerUserId(event) {
  const userId = event?.requestContext?.authorizer?.userId;
  return typeof userId === "string" && validateUUID(userId).valid ? userId : null;
}

/**
 * Resolve the acting user. `claimedUserId` is an optional client-supplied id
 * (path/query/body); when given it must match the token's user.
 * Returns { userId } or { statusCode, error }.
 */
function resolveCaller(event, claimedUserId) {
  const userId = callerUserId(event);
  if (!userId) {
    return { statusCode: 401, error: "A user session token is required" };
  }
  if (claimedUserId !== undefined && claimedUserId !== null && claimedUserId !== "" && claimedUserId !== userId) {
    return { statusCode: 403, error: "user_id does not match the session token" };
  }
  return { userId };
}

module.exports = { callerUserId, resolveCaller };
