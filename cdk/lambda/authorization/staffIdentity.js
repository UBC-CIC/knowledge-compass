/**
 * Staff (Cognito) identity in the users table, keyed on the Cognito `sub`.
 *
 * users.email is guest-writable (PUT /user/{user_id}), so it must never decide
 * which row is an administrator (finding f-23c5bf7c). Staff rows have
 * identity_source = 'cognito' and cognito_sub = the Cognito sub (migration
 * 039). An email match is used only to:
 *   (a) link a legacy 'cognito' row that has no sub yet and owns no chat
 *       sessions (created before migration 039), or
 *   (b) take the verified address away from any other row holding it.
 * A guest row is never linked, elevated or returned. With elevate=true the
 * link also requires role 'admin', so a non-admin row is not adopted. The
 * email select orders by admin role, then id.
 *
 * Lives under authorization/ because the PostConfirmation Lambda's asset is
 * lambda/authorization; handlers require it via ../../authorization/.
 * knowledgeBase/helpers/admin_user.py mirrors this algorithm and SQL; keep the
 * two in sync.
 *
 * Never logs email addresses, display names or ids.
 */

const { randomUUID } = require("crypto");

/** Trimmed, lower-cased email, or null when empty / not a string. */
const normalizeEmail = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

// Remove `email` from every row holding it except `keepId` (if given).
async function detachEmail(tx, email, keepId) {
  const detached = keepId
    ? await tx`
        UPDATE users SET email = NULL
        WHERE lower(email) = ${email} AND id <> ${keepId}
        RETURNING id
      `
    : await tx`
        UPDATE users SET email = NULL
        WHERE lower(email) = ${email}
        RETURNING id
      `;
  if (detached.length > 0) {
    console.log({ action: "detached_conflicting_email", count: detached.length });
  }
}

/**
 * Find, link or create the staff row for a Cognito user.
 *
 * @param sql      postgres.js client (must support sql.begin)
 * @param sub      Cognito sub (required)
 * @param email    Cognito-verified email (optional)
 * @param role     role for a newly created row ('admin' | 'student')
 * @param elevate  when true and role is 'admin', an existing row is set to admin
 * @param onWrite  optional async (tx, result) => void, called inside the same
 *                 transaction after the row is written (e.g. an admin_audit
 *                 insert); if it throws, the whole change rolls back
 * @returns {{ id, email, role, outcome: "existing" | "linked" | "created" }}
 */
async function ensureStaffUser(
  sql,
  { sub, email, displayName, role = "student", elevate = false, onWrite } = {}
) {
  const cognitoSub = typeof sub === "string" ? sub.trim() : "";
  if (!cognitoSub) throw new Error("ensureStaffUser requires a Cognito sub");
  const normalized = normalizeEmail(email);
  const elevateToAdmin = elevate === true && role === "admin";

  return sql.begin(async (tx) => {
    const finish = async (result) => {
      if (typeof onWrite === "function") await onWrite(tx, result);
      return result;
    };

    // Serialize concurrent first sign-ins of the same account.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-identity:${normalized || cognitoSub}`}, 0))`;

    const bySub = await tx`
      SELECT id, email, role FROM users WHERE cognito_sub = ${cognitoSub} FOR UPDATE
    `;
    if (bySub.length > 0) {
      const row = bySub[0];
      const nextRole = elevateToAdmin ? "admin" : row.role;
      let nextEmail = row.email;
      if (normalized && row.email !== normalized) {
        await detachEmail(tx, normalized, row.id);
        nextEmail = normalized;
      }
      const [updated] = await tx`
        UPDATE users
        SET last_seen_at = NOW(), role = ${nextRole}::user_role, email = ${nextEmail}
        WHERE id = ${row.id}
        RETURNING id, email, role
      `;
      return finish({ ...updated, outcome: "existing" });
    }

    if (normalized) {
      const holders = await tx`
        SELECT id, identity_source, cognito_sub, role,
               EXISTS (SELECT 1 FROM chat_sessions s WHERE s.user_id = users.id) AS has_sessions
        FROM users
        WHERE lower(email) = ${normalized}
        ORDER BY (role = 'admin'::user_role) DESC, id
        FOR UPDATE
      `;
      // Non-admin holders stay in the result so their email can be detached.
      // Elevating (promote / admin provision) never adopts one of them.
      const legacy = holders.find(
        (r) =>
          r.identity_source === "cognito" &&
          !r.cognito_sub &&
          !r.has_sessions &&
          (!elevateToAdmin || r.role === "admin")
      );
      if (legacy) {
        await detachEmail(tx, normalized, legacy.id);
        const nextRole = elevateToAdmin ? "admin" : legacy.role;
        // Bumping credential_version revokes any guest credential for the row.
        const [linked] = await tx`
          UPDATE users
          SET cognito_sub = ${cognitoSub},
              last_seen_at = NOW(),
              role = ${nextRole}::user_role,
              credential_version = credential_version + 1,
              credential_rotated_at = NULL
          WHERE id = ${legacy.id}
          RETURNING id, email, role
        `;
        return finish({ ...linked, outcome: "linked" });
      }
      if (holders.length > 0) await detachEmail(tx, normalized, null);
    }

    const [created] = await tx`
      INSERT INTO users (
        id, email, display_name, role, identity_source, cognito_sub, created_at, last_seen_at
      )
      VALUES (
        ${randomUUID()}, ${normalized}, ${displayName || null}, ${role}::user_role,
        'cognito', ${cognitoSub}, NOW(), NOW()
      )
      RETURNING id, email, role
    `;
    return finish({ ...created, outcome: "created" });
  });
}

module.exports = { ensureStaffUser, normalizeEmail };
