"""
Acting administrator's users row, keyed on the Cognito sub.

users.email is guest-writable (PUT /user/{user_id}), so it never decides which
row is an administrator (finding f-23c5bf7c). Staff rows have
identity_source = 'cognito' and cognito_sub = the Cognito sub from the admin
authorizer (requestContext.authorizer.userId); see migration 039.

Mirrors cdk/lambda/authorization/staffIdentity.js (ensureStaffUser with
role='admin', elevate=True); keep the algorithm and SQL in sync. An email
match is only used to link a legacy 'cognito' row with role 'admin' that has
no sub and owns no chat sessions, or to take the verified address away from
any other row. The email select orders by admin role, then id, so two holders
cannot resolve to an arbitrary row. A guest or any other non-admin row is
never linked or returned. (The JS-only `onWrite` hook, used for the
promote_user admin_audit insert, has no Python counterpart.)

Never logs email addresses or users ids. A privilege-changing write (admin
row created, legacy row linked, or a non-admin row elevated) logs one
structured line with the acting admin's Cognito sub and the outcome only
(finding f-7f03f151).
"""

import json
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _log_provision(actor_sub: str, outcome: str) -> None:
    """One audit line for an admin-row write: actor sub and outcome, nothing else."""
    logger.info(json.dumps({"audit": "admin_user.provision", "actor_sub": actor_sub, "outcome": outcome}))


def normalize_email(email: str | None) -> str:
    return (email or "").strip().lower()


def _authorizer(event) -> dict:
    return ((event or {}).get("requestContext") or {}).get("authorizer") or {}


def admin_email_from_request(event, body=None) -> str:
    """The Cognito email from the admin authorizer. `body` is ignored (kept
    for call compatibility): a request body must never pick the identity."""
    return normalize_email(_authorizer(event).get("email"))


def admin_sub_from_request(event) -> str | None:
    """The Cognito sub from the admin authorizer, or None."""
    sub = _authorizer(event).get("userId")
    if isinstance(sub, str) and sub.strip():
        return sub.strip()
    return None


def _detach_email(cursor, email: str, keep_id: str | None) -> None:
    """Remove `email` from every row holding it except `keep_id`."""
    if keep_id:
        cursor.execute(
            "UPDATE users SET email = NULL WHERE lower(email) = %s AND id <> %s::uuid",
            (email, keep_id),
        )
    else:
        cursor.execute("UPDATE users SET email = NULL WHERE lower(email) = %s", (email,))
    if cursor.rowcount and cursor.rowcount > 0:
        logger.info("detached_conflicting_email count=%s", cursor.rowcount)


def get_or_create_admin_user_id(connection, sub: str | None, email: str | None = None) -> str | None:
    """
    Return the users.id of the admin with this Cognito sub: the row already
    linked to the sub, else the admin's legacy row (linked now), else a new
    'cognito' row. The row is set to role 'admin' (the admin authorizer has
    proved Cognito admin-group membership). The caller commits.
    """
    cognito_sub = sub.strip() if isinstance(sub, str) else ""
    if not cognito_sub:
        return None
    normalized = normalize_email(email) or None

    with connection.cursor() as cursor:
        # Serialize concurrent first requests of the same account.
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"staff-identity:{normalized or cognito_sub}",),
        )

        cursor.execute(
            "SELECT id, email, role FROM users WHERE cognito_sub = %s FOR UPDATE",
            (cognito_sub,),
        )
        row = cursor.fetchone()
        if row:
            user_id = str(row[0])
            next_email = row[1]
            if normalized and row[1] != normalized:
                _detach_email(cursor, normalized, user_id)
                next_email = normalized
            cursor.execute(
                """
                UPDATE users
                SET last_seen_at = now(), role = 'admin'::user_role, email = %s
                WHERE id = %s::uuid
                RETURNING id
                """,
                (next_email, user_id),
            )
            updated = cursor.fetchone()
            if row[2] != "admin":
                _log_provision(cognito_sub, "elevated")
            return str(updated[0]) if updated else user_id

        if normalized:
            # Every holder is locked, including non-admins: their address has to
            # be detached before the insert below or users_email_lower_key
            # rejects the new row. Only a legacy admin (no sub, no chats) is
            # linked. ORDER BY makes that choice deterministic when more than
            # one admin row matches.
            cursor.execute(
                """
                SELECT id, identity_source, cognito_sub,
                       EXISTS (SELECT 1 FROM chat_sessions s WHERE s.user_id = users.id) AS has_sessions,
                       role
                FROM users
                WHERE lower(email) = %s
                ORDER BY (role = 'admin'::user_role) DESC, id
                FOR UPDATE
                """,
                (normalized,),
            )
            holders = cursor.fetchall() or []
            legacy = next(
                (
                    h
                    for h in holders
                    if h[1] == "cognito" and not h[2] and not h[3] and h[4] == "admin"
                ),
                None,
            )
            if legacy:
                legacy_id = str(legacy[0])
                _detach_email(cursor, normalized, legacy_id)
                # Bumping credential_version revokes any guest credential for the row.
                cursor.execute(
                    """
                    UPDATE users
                    SET cognito_sub = %s,
                        last_seen_at = now(),
                        role = 'admin'::user_role,
                        credential_version = credential_version + 1,
                        credential_rotated_at = NULL
                    WHERE id = %s::uuid
                    RETURNING id
                    """,
                    (cognito_sub, legacy_id),
                )
                linked = cursor.fetchone()
                _log_provision(cognito_sub, "linked")
                return str(linked[0]) if linked else legacy_id
            if holders:
                _detach_email(cursor, normalized, None)

        cursor.execute(
            """
            INSERT INTO users (
                id, email, display_name, role, identity_source, cognito_sub, created_at, last_seen_at
            )
            VALUES (uuid_generate_v4(), %s, %s, 'admin'::user_role, 'cognito', %s, now(), now())
            RETURNING id
            """,
            (normalized, normalized, cognito_sub),
        )
        created = cursor.fetchone()
        _log_provision(cognito_sub, "created")
        return str(created[0]) if created else None
