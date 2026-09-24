"""
Removing uploaded data sources together with the retrieval data they own.

Shared by explicit deletes (delete_data_source.py) and by re-uploads that
supersede older duplicate rows of the same file (stage_data_sources.py), so a
superseded version never lingers as live, queryable chunks.

Everything here runs inside the caller's transaction. S3 objects cannot be
rolled back, so they are returned for the caller to delete after commit.
"""

from helpers.upload_identity import (
    delete_unreferenced_source,
    parse_s3_uri,
    rename_source_url,
    source_url_for,
)

UPLOAD_TYPES = ("csv", "markdown", "document", "video")


def _find_companion_row(connection, *, s3_bucket: str | None, s3_key: str | None) -> dict | None:
    """Find the paired data_sources row (e.g. the .metadata.json for a csv/markdown file)"""
    if not s3_bucket or not s3_key:
        return None
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, name, type, metadata
            FROM data_sources
            WHERE metadata->>'s3_bucket' = %s
              AND metadata->>'s3_key' = %s
            LIMIT 1
            """,
            (s3_bucket, s3_key),
        )
        row = cursor.fetchone()
    if not row:
        return None
    return {"id": str(row[0]), "name": row[1], "type": row[2], "metadata": row[3] or {}}


def plan_removal(connection, rows: list[dict]) -> dict:
    """
    Everything owned by `rows` (dicts with id, type, metadata): their
    csv/markdown <-> metadata JSON companions, their S3 objects (uploads and
    video transcripts), and the sources.url their chunks are stored under.
    """
    targets: dict[str, dict] = {}
    for row in rows:
        targets.setdefault(row["id"], row)
        if row["type"] in ("csv", "markdown", "json"):
            companion = _find_companion_row(
                connection,
                s3_bucket=row["metadata"].get("companion_s3_bucket"),
                s3_key=row["metadata"].get("companion_s3_key"),
            )
            if companion:
                targets.setdefault(companion["id"], companion)

    s3_objects: list[tuple[str, str]] = []
    source_urls: list[str] = []
    for target in targets.values():
        metadata = target["metadata"]
        if metadata.get("s3_bucket") and metadata.get("s3_key"):
            s3_objects.append((metadata["s3_bucket"], metadata["s3_key"]))
        if target["type"] == "video":
            for uri in {metadata.get("transcribe_output_s3_uri"), metadata.get("transcript_s3_uri")}:
                parsed = parse_s3_uri(uri)
                if parsed:
                    s3_objects.append(parsed)
        if target["type"] in UPLOAD_TYPES:
            url = source_url_for(target["type"], metadata)
            if url:
                source_urls.append(url)

    return {"ids": list(targets), "s3_objects": s3_objects, "source_urls": source_urls}


def remove_data_sources(connection, plan: dict):
    """
    Delete the planned data_sources rows and their ingestion_runs (no ON
    DELETE CASCADE on that FK), then each sources row (chunks cascade) that no
    remaining data source still maps to.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM ingestion_runs WHERE data_source_id = ANY(%s::uuid[])",
            (plan["ids"],),
        )
        cursor.execute(
            "DELETE FROM data_sources WHERE id = ANY(%s::uuid[])",
            (plan["ids"],),
        )
    for url in plan["source_urls"]:
        delete_unreferenced_source(connection, url=url)


def supersede_duplicates(connection, existing: dict, *, survivor_url: str | None) -> list[tuple[str, str]]:
    """
    Remove the older duplicate rows of a re-uploaded file (existing["duplicates"],
    from find_existing_upload) so only the surviving row's chunks stay live.

    If the survivor has no sources row yet, the newest duplicate's is moved to
    survivor_url first, so its chunks keep serving until the survivor is
    re-ingested and their content hashes still spare unchanged chunks from
    re-embedding. Call after the survivor's metadata points at survivor_url.

    Returns the duplicates' S3 objects for the caller to delete after commit.
    """
    duplicates = existing.get("duplicates") or []
    if not duplicates:
        return []

    for duplicate in duplicates:  # newest first
        rename_source_url(
            connection,
            old_url=source_url_for(duplicate["type"], duplicate["metadata"]),
            new_url=survivor_url,
        )

    plan = plan_removal(connection, duplicates)
    remove_data_sources(connection, plan)
    return plan["s3_objects"]
