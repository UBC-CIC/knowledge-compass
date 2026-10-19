/**
 * 038_web_source_owners.js
 *
 * Crawl provenance for website data sources (finding
 * f-a3f59ef3-689b-47e7-9abe-94c3a81de26f). The crawler writes one `sources`
 * row for the seed URL plus one per crawled page (the pages hold the chunks),
 * but nothing recorded which website data source a page came from, so
 * deleting a website only removed the seed row and every page stayed live in
 * retrieval.
 *
 * Changes:
 *   1. New table web_source_owners (source_id, data_source_id): which website
 *      data source(s) crawled a 'web' sources row. A link table, not a single
 *      sources column, because sources.url is globally unique and the crawler
 *      upserts on it, so two websites that crawl the same URL share one row.
 *      Ownership is additive: a re-crawl only adds/refreshes its own link.
 *      Deleting a website (knowledgeBase/helpers/web_sources.py) deletes the
 *      pages it solely owns; pages another live website also owns are kept and
 *      only lose this website's link (ON DELETE CASCADE from data_sources).
 *   2. Backfill: each existing 'web' row is linked to every website data
 *      source whose site contains it. Site rule (mirrored in
 *      web_sources.site_host / url_in_site): http(s) host, lowercased, one
 *      trailing '.' and one leading 'www.' removed; a URL is in a site when its
 *      host equals the site host or ends with '.' || site host. Host equality /
 *      dot-suffix, never a string prefix, so look-alikes such as
 *      example.org.evil.com or example.org@evil.com never match example.org.
 *   3. One-time reconciliation: 'web' rows that still have no owner belong to
 *      no live website (left behind by earlier website deletes) and are
 *      deleted; their chunks and chunk_embeddings cascade.
 *
 * Known edge: pages whose host differs from the seed host (e.g. a seed that
 * redirects to another domain) cannot be attributed by the backfill and are
 * purged here. Re-sync live websites after deploying; the updated crawler
 * stamps ownership on every page it writes.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS web_source_owners (
      source_id      uuid        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      data_source_id uuid        NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
      first_seen_at  timestamptz NOT NULL DEFAULT now(),
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source_id, data_source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_web_source_owners_data_source_id
      ON web_source_owners (data_source_id);
  `);

  pgm.sql(`
    WITH pages AS (
      SELECT s.id,
             regexp_replace(regexp_replace(
               substring(lower(btrim(s.url)) from '^https?://(?:[^/?#@]*@)?([^/:?#]+)'),
               '\\.$', ''), '^www\\.', '') AS host
      FROM sources s
      WHERE s.source_type = 'web'::source_type
    ),
    websites AS (
      SELECT ds.id,
             regexp_replace(regexp_replace(
               substring(lower(btrim(ds.name)) from '^https?://(?:[^/?#@]*@)?([^/:?#]+)'),
               '\\.$', ''), '^www\\.', '') AS host
      FROM data_sources ds
      WHERE ds.type = 'website'::data_source_type
    )
    INSERT INTO web_source_owners (source_id, data_source_id)
    SELECT p.id, w.id
    FROM pages p
    JOIN websites w
      ON p.host <> '' AND w.host <> ''
     AND (p.host = w.host OR right(p.host, length(w.host) + 1) = '.' || w.host)
    ON CONFLICT DO NOTHING;
  `);

  pgm.sql(`
    DELETE FROM sources s
    WHERE s.source_type = 'web'::source_type
      AND NOT EXISTS (
        SELECT 1 FROM web_source_owners o WHERE o.source_id = s.id
      );
  `);
};

exports.down = (pgm) => {
  // Drops provenance only. Rows purged by up() are not restorable: they
  // belonged to websites that no longer exist (re-sync to recreate).
  pgm.sql(`
    DROP TABLE IF EXISTS web_source_owners;
  `);
};
