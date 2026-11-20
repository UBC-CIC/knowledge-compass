/**
 * Audit trail for privileged admin actions (finding f-0d57a9d0, migration
 * 040_admin_audit).
 *
 * The actor always comes from the verified admin authorizer context
 * (requestContext.authorizer.userId / .email), never from the request body.
 * Callers insert the row with the same transaction as the change it records,
 * and call logAdminAudit only after that transaction commits, so a log line
 * never describes a change that was rolled back.
 *
 * `target` holds ids and field names only: never prompt content, setting
 * values, tokens or guest personal data. The admin's own email is allowed.
 * One exception: a system settings update records the new service status
 * (one of three fixed values), so a pause or resume of public chat is
 * visible; the service message is never recorded.
 */

const { adminSubFromEvent } = require("./adminIdentity.js");
const { normalizeEmail } = require("../../authorization/staffIdentity.js");

/**
 * @returns {{ actorSub, actorEmail, action, target, requestId }}
 * @throws when the authorizer context has no sub (routes 401 before this).
 */
function auditEntry(event, action, target = {}) {
  const actorSub = adminSubFromEvent(event);
  if (!actorSub) throw new Error("audit actor missing");
  return {
    actorSub,
    actorEmail: normalizeEmail(event.requestContext.authorizer.email),
    action,
    target,
    requestId: event.requestContext.requestId ?? null,
  };
}

/** Insert one admin_audit row with `tx` (a postgres.js client or transaction). */
async function insertAdminAudit(tx, entry) {
  await tx`
    INSERT INTO admin_audit (actor_sub, actor_email, action, target, request_id)
    VALUES (
      ${entry.actorSub}, ${entry.actorEmail}, ${entry.action},
      ${JSON.stringify(entry.target ?? {})}::jsonb, ${entry.requestId}
    )
  `;
}

/** One structured log line for a committed admin action. */
function logAdminAudit(entry) {
  console.log(
    JSON.stringify({
      audit: "admin_action",
      action: entry.action,
      actorSub: entry.actorSub,
      actorEmail: entry.actorEmail,
      target: entry.target,
      requestId: entry.requestId,
    })
  );
}

module.exports = { auditEntry, insertAdminAudit, logAdminAudit };
