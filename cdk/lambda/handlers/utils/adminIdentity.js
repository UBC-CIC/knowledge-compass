/**
 * Resolve the acting administrator's users row from the admin authorizer.
 *
 * Keyed on the Cognito sub (requestContext.authorizer.userId), never on
 * users.email, which guests can write (finding f-23c5bf7c). A miss links the
 * admin's legacy row or creates one (authorization/staffIdentity.js).
 *
 * The admin authorizer only passes members of the Cognito "admin" group, and
 * that group is the authoritative admin marker. A row that is not yet
 * role 'admin' (created as 'student' by the ingestion path or by
 * PostConfirmation before the group was assigned, or never promoted because
 * the login page's POST /admin/promote_user did not run) is elevated here,
 * with the same admin_audit record as promote_user, instead of being refused.
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
 *   row could not be made an admin.
 */
async function resolveAdminUser(sql, event) {
  const sub = adminSubFromEvent(event);
  if (!sub) return { statusCode: 401, error: "Unauthorized" };

  const rows = await sql`SELECT id, role FROM users WHERE cognito_sub = ${sub} LIMIT 1`;
  let row = rows[0];
  if (!row || row.role !== "admin") {
    // Required here, not at the top: adminAudit.js requires this module.
    const { auditEntry, insertAdminAudit, logAdminAudit } = require("./adminAudit.js");
    const email = normalizeEmail(event.requestContext.authorizer.email);
    let audit;
    row = await ensureStaffUser(sql, {
      sub,
      email,
      displayName: email,
      role: "admin",
      elevate: true,
      onWrite: (tx, written) => {
        audit = auditEntry(event, "admin.promote_user", {
          user_id: written.id,
          outcome: written.outcome,
          role: written.role,
          via: "admin_reauth",
        });
        return insertAdminAudit(tx, audit);
      },
    });
    if (audit) logAdminAudit(audit);
  }
  if (row?.role !== "admin") return { statusCode: 403, error: "User is not an admin" };
  return { id: row.id, role: row.role };
}

module.exports = { adminSubFromEvent, resolveAdminUser };
