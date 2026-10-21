"""
Which administrator each presigned upload was issued to (migration 045).

Staging takes the uploaded object's bucket/key from the request body, so the
presign endpoints record every key they issue against the acting admin's
Cognito sub, and staging only accepts a key that was issued to the same admin,
is still inside its staging window, and has not been staged before. Without
this, one admin could name another's upload and have the replace path delete
it (finding f-cedd2bee).

The issuer is always the authorizer's sub (admin_user.admin_sub_from_request),
never a request body value.
"""

# How long after issuance an upload may be staged. Generous: the URL itself
# expires in minutes to an hour, but a large video can take a while to upload.
STAGE_WINDOW_SECONDS = 24 * 3600

# Rows this long past their window are purged when new URLs are issued.
_PURGE_AFTER_SECONDS = 7 * 24 * 3600


def record_issued_uploads(connection, *, issued_to: str, bucket: str, keys: list[str]):
    """Record keys about to be handed out as presigned URLs. The caller commits."""
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM upload_issuances WHERE expires_at < now() - make_interval(secs => %s)",
            (_PURGE_AFTER_SECONDS,),
        )
        for key in keys:
            cursor.execute(
                """
                INSERT INTO upload_issuances (s3_bucket, s3_key, issued_to_sub, expires_at)
                VALUES (%s, %s, %s, now() + make_interval(secs => %s))
                """,
                (bucket, key, issued_to, STAGE_WINDOW_SECONDS),
            )


_UNCLAIMED_SQL = """
    SELECT s3_bucket, s3_key
    FROM upload_issuances
    WHERE (s3_bucket, s3_key) IN ({placeholders})
      AND issued_to_sub = %s
      AND consumed_at IS NULL
      AND expires_at > now()
"""


def _select_unclaimed(cursor, *, issued_to: str, objects: list[tuple[str, str]], lock: bool) -> tuple[int, int]:
    """(claimable rows found, distinct objects asked for)."""
    distinct = list(dict.fromkeys(objects))
    placeholders = ", ".join(["(%s, %s)"] * len(distinct))
    params = [value for obj in distinct for value in obj] + [issued_to]
    sql = _UNCLAIMED_SQL.format(placeholders=placeholders)
    cursor.execute(sql + (" FOR UPDATE" if lock else ""), params)
    return len(cursor.fetchall()), len(distinct)


def has_unclaimed_uploads(connection, *, issued_to: str, objects: list[tuple[str, str]]) -> bool:
    """
    Read-only pre-check, before the objects are read from S3: every object
    was issued to `issued_to` and is still claimable. claim_issued_uploads
    re-checks under a row lock.
    """
    if not issued_to or not objects:
        return False
    with connection.cursor() as cursor:
        found, wanted = _select_unclaimed(cursor, issued_to=issued_to, objects=objects, lock=False)
    return found == wanted


def claim_issued_uploads(connection, *, issued_to: str, objects: list[tuple[str, str]]) -> bool:
    """
    Mark the objects as staged, inside the staging transaction, so each upload
    can be staged once. Call before the staging transaction's first write:
    when it returns False nothing has been written. The row lock makes a
    concurrent stage of the same key wait, then see it consumed.
    """
    if not issued_to or not objects:
        return False
    with connection.cursor() as cursor:
        found, wanted = _select_unclaimed(cursor, issued_to=issued_to, objects=objects, lock=True)
        if found != wanted:
            return False
        distinct = list(dict.fromkeys(objects))
        placeholders = ", ".join(["(%s, %s)"] * len(distinct))
        cursor.execute(
            f"""
            UPDATE upload_issuances
            SET consumed_at = now()
            WHERE (s3_bucket, s3_key) IN ({placeholders})
            """,
            [value for obj in distinct for value in obj],
        )
    return True
