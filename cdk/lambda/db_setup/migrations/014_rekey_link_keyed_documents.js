/**
 * 014_rekey_link_keyed_documents.js
 *
 * One-time re-key: an uploaded document's chunks used to be stored under its
 * optional `document_url` (sources.url) when one was entered. That made an
 * optional form field the storage key, so two different documents given the
 * same link were ingested into ONE sources row, each ingestion overwriting the
 * other's chunks. Uploads now always store chunks under an internal
 * upload:// key and keep the link only as sources.metadata.citation_url,
 * which retrieval shows as the citation (see upload_identity.py).
 *
 * For every document data source whose chunks are keyed by a link:
 * - its data_sources.metadata gets source_url = its source_key if it has one,
 *   else `upload://document/id/<data source id>` (stable: re-uploads reuse
 *   the same row, and the next re-upload moves it to the file-name key);
 * - per link, the sources row goes to the data source whose chunks it holds:
 *   the one that completed ingestion last. It is renamed to that data
 *   source's new url (no re-embedding) with the link kept as citation_url;
 * - any other data source that shared the link lost its chunks to those
 *   overwrites, so it gets a 'pending' ingestion run: an admin clicking Sync
 *   now re-embeds it into its own sources row.
 * Links whose data sources have a run queued/running are skipped (their rows
 * keep working the old way until re-uploaded).
 */

// sources.url a data_sources row `ds` maps to before this migration; must
// match upload_identity.source_url_for / DATA_SOURCE_URL_SQL.
const DATA_SOURCE_URL_SQL = `
  COALESCE(
    ds.metadata->>'source_url',
    CASE
      WHEN ds.type = 'video'::data_source_type
        THEN NULLIF(btrim(ds.metadata->>'video_url'), '')
      WHEN ds.type = 'document'::data_source_type
       AND COALESCE(btrim(ds.metadata->>'document_url'), '') <> ''
        THEN btrim(ds.metadata->>'document_url')
      ELSE 's3://' || (ds.metadata->>'s3_bucket') || '/' || (ds.metadata->>'s3_key')
    END
  )`;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TEMP TABLE kc_link_keyed ON COMMIT DROP AS
    WITH latest_runs AS (
      SELECT DISTINCT ON (ir.data_source_id) ir.data_source_id, ir.status
      FROM ingestion_runs ir
      ORDER BY ir.data_source_id, ir.created_at DESC, ir.id DESC
    ),
    last_completed AS (
      SELECT ir.data_source_id, max(COALESCE(ir.finished_at, ir.completed_at, ir.created_at)) AS at
      FROM ingestion_runs ir
      WHERE ir.status = 'completed'::ingestion_status
      GROUP BY ir.data_source_id
    ),
    docs AS (
      SELECT
        ds.id,
        ds.created_at,
        ${DATA_SOURCE_URL_SQL} AS link,
        COALESCE(ds.metadata->>'source_key', 'upload://document/id/' || ds.id::text) AS new_url,
        lr.status AS latest_status,
        lc.at AS last_completed_at
      FROM data_sources ds
      LEFT JOIN latest_runs lr ON lr.data_source_id = ds.id
      LEFT JOIN last_completed lc ON lc.data_source_id = ds.id
      WHERE ds.type = 'document'::data_source_type
    ),
    link_keyed AS (
      SELECT *
      FROM docs
      WHERE link IS NOT NULL
        AND link NOT LIKE 'upload://%'
        AND link NOT LIKE 's3://%'
    )
    SELECT
      k.*,
      ROW_NUMBER() OVER (
        PARTITION BY k.link
        ORDER BY k.last_completed_at DESC NULLS LAST, k.created_at DESC, k.id DESC
      ) AS rn
    FROM link_keyed k
    WHERE k.link NOT IN (
      SELECT link
      FROM link_keyed
      WHERE latest_status IN ('queued'::ingestion_status, 'running'::ingestion_status)
    );
  `);

  await pgm.sql(`
    -- The data source whose chunks the link's sources row holds takes it over.
    UPDATE sources s
    SET url = k.new_url,
        metadata = s.metadata || jsonb_build_object('citation_url', k.link),
        updated_at = now()
    FROM kc_link_keyed k
    WHERE k.rn = 1
      AND s.url = k.link
      AND s.source_type = 'document'::source_type
      AND NOT EXISTS (SELECT 1 FROM sources taken WHERE taken.url = k.new_url);

    UPDATE data_sources ds
    SET metadata = ds.metadata || jsonb_build_object('source_url', k.new_url)
    FROM kc_link_keyed k
    WHERE ds.id = k.id;

    -- Documents whose chunks were overwritten through a shared link: re-embed on Sync.
    INSERT INTO ingestion_runs (data_source_id, status, metadata)
    SELECT k.id, 'pending'::ingestion_status, '{"action": "rekey_shared_document_link"}'::jsonb
    FROM kc_link_keyed k
    WHERE k.rn > 1
      AND k.latest_status IS DISTINCT FROM 'pending'::ingestion_status;

    -- Any link-keyed sources row nothing maps to any more (e.g. its new url was taken).
    DELETE FROM sources s
    WHERE s.url IN (SELECT link FROM kc_link_keyed)
      AND s.source_type = 'document'::source_type
      AND NOT EXISTS (
        SELECT 1
        FROM data_sources ds
        WHERE ds.type = ANY(ARRAY['csv', 'markdown', 'document', 'video']::data_source_type[])
          AND ${DATA_SOURCE_URL_SQL} = s.url
      );
  `);
};

exports.down = () => {
  // Not reversible: shared-link sources rows held one document's chunks, and
  // the others are re-embedded under their own keys.
};
