"""
Removing the pgvector pages a website data source's crawls created.

The crawler writes one 'web' `sources` row for the seed URL plus one per
crawled page (the pages hold the chunks), and links each to the crawling
website in `web_source_owners` (migration 038).

Ownership semantics: `sources.url` is globally unique and the crawler upserts
on it, so two websites that crawl the same URL share one row. Ownership is
additive (a re-crawl only adds/refreshes its own link). Deleting a website
deletes the pages it solely owns; pages another live website also owns are
kept and only lose this website's link (it cascades with the data_sources row).

Rows with no owner at all (written before migration 038, or by a crawler image
that predates it) are swept by site: an unowned 'web' row inside the deleted
website's site is deleted unless it is also inside the site of another live
website. Site matching is host equality / dot-suffix on the parsed hostname,
never a string prefix, so look-alikes (example.org.evil.com,
example.org@evil.com) never match and no LIKE wildcard escaping is involved.
This mirrors the host rule migration 038 used for its backfill.

Chunks and chunk_embeddings cascade from `sources`. Everything runs inside the
caller's transaction; nothing here commits.
"""

import logging
from urllib.parse import urlsplit

logger = logging.getLogger()


def site_host(url) -> str | None:
    """Normalized http(s) host of `url` (lowercase, no trailing '.', one 'www.' removed), else None."""
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url.strip())
        if parts.scheme.lower() not in ("http", "https"):
            return None
        host = parts.hostname
    except ValueError:
        return None
    if not host:
        return None
    if host.endswith("."):
        host = host[:-1]
    if host.startswith("www."):
        host = host[len("www."):]
    return host or None


def url_in_site(url, site_url) -> bool:
    """True when `url`'s host is the site's host or a subdomain of it."""
    host, site = site_host(url), site_host(site_url)
    if not host or not site:
        return False
    return host == site or host.endswith("." + site)


def delete_website_pages(connection, *, data_source_id: str, seed_url: str) -> dict:
    """
    Delete the 'web' sources rows owned only by this website, then unowned
    legacy rows inside its site. Call before the data_sources row is deleted.

    Returns {"deleted_page_count", "retained_shared_page_count"}.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            DELETE FROM sources s
            USING web_source_owners o
            WHERE o.source_id = s.id
              AND o.data_source_id = %s::uuid
              AND s.source_type = 'web'::source_type
              AND NOT EXISTS (
                SELECT 1 FROM web_source_owners other
                WHERE other.source_id = s.id
                  AND other.data_source_id <> %s::uuid
              )
            RETURNING s.id
            """,
            (data_source_id, data_source_id),
        )
        owned_deleted = len(cursor.fetchall())

        cursor.execute(
            "SELECT count(*) FROM web_source_owners WHERE data_source_id = %s::uuid",
            (data_source_id,),
        )
        row = cursor.fetchone()
        shared = int(row[0]) if row and row[0] else 0

        cursor.execute(
            """
            SELECT s.id, s.url
            FROM sources s
            WHERE s.source_type = 'web'::source_type
              AND NOT EXISTS (
                SELECT 1 FROM web_source_owners o WHERE o.source_id = s.id
              )
            """
        )
        unowned = cursor.fetchall()

        fallback_deleted = 0
        if unowned:
            cursor.execute(
                """
                SELECT name FROM data_sources
                WHERE type = 'website'::data_source_type
                  AND id <> %s::uuid
                """,
                (data_source_id,),
            )
            other_sites = [r[0] for r in cursor.fetchall()]
            candidates = [
                str(source_id)
                for source_id, url in unowned
                if (url == seed_url or url_in_site(url, seed_url))
                and not any(url == other or url_in_site(url, other) for other in other_sites)
            ]
            if candidates:
                cursor.execute(
                    """
                    DELETE FROM sources s
                    WHERE s.id = ANY(%s::uuid[])
                      AND s.source_type = 'web'::source_type
                      AND NOT EXISTS (
                        SELECT 1 FROM web_source_owners o WHERE o.source_id = s.id
                      )
                    RETURNING s.id
                    """,
                    (candidates,),
                )
                fallback_deleted = len(cursor.fetchall())

    logger.info(
        "Website %s pages: %d owned deleted, %d unowned deleted, %d shared retained",
        data_source_id,
        owned_deleted,
        fallback_deleted,
        shared,
    )
    return {
        "deleted_page_count": owned_deleted + fallback_deleted,
        "retained_shared_page_count": shared,
    }
