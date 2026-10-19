/**
 * Resolve the acting administrator's users row from the admin authorizer.
 *
 * Keyed on the Cognito sub (requestContext.authorizer.userId), never on
 * users.email, which guests can write (finding f-23c5bf7c). A miss links the
 * admin's legacy row or creates one (authorization/staffIdentity.js).
 */

const { ensureStaffUser, normalizeEmail } = require("../../authorization/staffIdentity.js");

/** Cognito sub from the admin authorizer context, or null. */
function adminSubFromEvent(event) {
  const sub = event?.requestContext?.authorizer?.userId;
  return typeof sub === "string" && sub.trim() ? sub.trim() : null;
}

/**
 * @returns {{ id, role }} for an admin, or {{ statusCode, error }}:
 *   401 "Unauthorized" without a sub, 403 "User is not an admin" when the
 *   row's role is not admin.
 */
async function resolveAdminUser(sql, event) {
  const sub = adminSubFromEvent(event);
  if (!sub) return { statusCode: 401, error: "Unauthorized" };

  const rows = await sql`SELECT id, role FROM users WHERE cognito_sub = ${sub} LIMIT 1`;
  let row = rows[0];
  if (!row) {
    const email = normalizeEmail(event.requestContext.authorizer.email);
    row = await ensureStaffUser(sql, { sub, email, displayName: email, role: "admin", elevate: false });
  }
  if (row.role !== "admin") return { statusCode: 403, error: "User is not an admin" };
  return { id: row.id, role: row.role };
}

module.exports = { adminSubFromEvent, resolveAdminUser };
