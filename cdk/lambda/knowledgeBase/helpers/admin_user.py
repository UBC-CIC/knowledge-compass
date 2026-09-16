import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def normalize_email(email: str | None) -> str:
    return (email or "").strip().lower()


def admin_email_from_request(event, body) -> str:
    """Prefer the Cognito email from the authorizer; fall back to the request body."""
    authorizer = (event.get("requestContext") or {}).get("authorizer") or {}
    return normalize_email(authorizer.get("email") or (body or {}).get("created_by"))


def get_user_id_by_email(connection, email: str) -> str | None:
    """Look up a user id with a case-insensitive email match."""
    normalized = normalize_email(email)
    if not normalized:
        return None
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM users
            WHERE lower(email) = %s
            LIMIT 1
            """,
            (normalized,),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def get_or_create_admin_user_id(connection, email: str) -> str | None:
    """
    Return the users.id for this admin email, inserting a row if Cognito
    authenticated them but the post-confirmation trigger never created one.
    """
    normalized = normalize_email(email)
    if not normalized:
        return None

    existing = get_user_id_by_email(connection, normalized)
    if existing:
        return existing

    logger.info("Creating missing admin users row for %s", normalized)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO users (id, email, display_name, role, created_at, last_seen_at)
            VALUES (uuid_generate_v4(), %s, %s, 'admin'::user_role, now(), now())
            ON CONFLICT (email) DO UPDATE
              SET role = 'admin'::user_role,
                  last_seen_at = now()
            RETURNING id
            """,
            (normalized, normalized),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None
