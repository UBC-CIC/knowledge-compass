/**
 * 013_delete_superseded_upload_duplicates.js
 *
 * One-time cleanup: before uploads had a stable identity (see
 * knowledgeBase/helpers/upload_identity.py), every re-upload of the same
 * csv/markdown/document/video file inserted a new data_sources row keyed to a
 * new timestamped S3 key, and its chunks went into a new `sources` row. The
 * older versions were never removed, so their chunks stayed live in retrieval
 * next to the newer ones. Re-uploads now supersede older duplicates at staging
 * time (data_source_cleanup.supersede_duplicates); this removes the backlog.
 *
 * Rows are grouped by type + case-insensitive original file name (the same
 * legacy match staging uses). In each group of 2+ rows:
 * - the newest row survives (it is the version the admin uploaded last);
 * - if the survivor has no `sources` row yet (e.g. staged but never synced),
 *   the newest duplicate's `sources` row is moved to the survivor's url, so
 *   its chunks keep serving and their content hashes spare unchanged chunks
 *   from re-embedding when the survivor is synced;
 * - the other rows, their metadata-JSON companions and their ingestion_runs
 *   are deleted, then any `sources` row they owned that no remaining data
 *   source maps to (chunks cascade).
 * Groups with a run queued/running or a video still transcribing are skipped;
 * the next re-upload of that file cleans them up instead.
 *
 * S3 objects of the deleted rows are not touched (SQL cannot reach S3). They
 * no longer affect retrieval and only cost storage.
 */

// sources.url a data_sources row `ds` maps to; must match
// upload_identity.source_url_for / DATA_SOURCE_URL_SQL.
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
    CREATE TEMP TABLE kc_upload_versions ON COMMIT DROP AS
    WITH latest_runs AS (
      SELECT DISTINCT ON (ir.data_source_id) ir.data_source_id, ir.status
      FROM ingestion_runs ir
      ORDER BY ir.data_source_id, ir.created_at DESC, ir.id DESC
    ),
    uploads AS (
      SELECT
        ds.id,
        ds.created_at,
        ds.metadata,
        ds.type::text || ':' || lower(
          CASE ds.type
            WHEN 'document'::data_source_type THEN ds.metadata->>'document_file_name'
            WHEN 'video'::data_source_type THEN ds.metadata->>'video_file_name'
            ELSE ds.name
          END
        ) AS identity,
        ${DATA_SOURCE_URL_SQL} AS url,
        COALESCE(
          lr.status IN ('queued'::ingestion_status, 'running'::ingestion_status)
          OR ds.metadata->>'transcribe_status' = 'IN_PROGRESS',
          false
        ) AS in_flight
      FROM data_sources ds
      LEFT JOIN latest_runs lr ON lr.data_source_id = ds.id
      WHERE ds.type = ANY(ARRAY['csv', 'markdown', 'document', 'video']::data_source_type[])
    ),
    versions AS (
      SELECT
        u.*,
        ROW_NUMBER() OVER (PARTITION BY u.identity ORDER BY u.created_at DESC, u.id DESC) AS rn
      FROM uploads u
      WHERE u.identity IS NOT NULL
    )
    SELECT v.*
    FROM versions v
    WHERE v.identity IN (
      SELECT identity
      FROM versions
      GROUP BY identity
      HAVING count(*) > 1 AND NOT bool_or(in_flight)
    );
  `);

  // Survivor without a sources row: adopt the newest duplicate's. Picked one
  // per survivor url and one per duplicate url so the UNIQUE (url) holds.
  await pgm.sql(`
    WITH candidates AS (
      SELECT d.url AS dup_url, sv.url AS survivor_url, d.rn
      FROM kc_upload_versions d
      JOIN kc_upload_versions sv ON sv.identity = d.identity AND sv.rn = 1
      WHERE d.rn > 1
        AND d.url IS NOT NULL
        AND sv.url IS NOT NULL
        AND d.url <> sv.url
        AND EXISTS (SELECT 1 FROM sources s WHERE s.url = d.url)
        AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.url = sv.url)
    ),
    per_survivor AS (
      SELECT DISTINCT ON (survivor_url) dup_url, survivor_url
      FROM candidates
      ORDER BY survivor_url, rn
    ),
    picks AS (
      SELECT DISTINCT ON (dup_url) dup_url, survivor_url
      FROM per_survivor
      ORDER BY dup_url, survivor_url
    )
    UPDATE sources s
    SET url = picks.survivor_url, updated_at = now()
    FROM picks
    WHERE s.url = picks.dup_url;
  `);

  await pgm.sql(`
    CREATE TEMP TABLE kc_superseded_ids ON COMMIT DROP AS
    SELECT d.id
    FROM kc_upload_versions d
    WHERE d.rn > 1
    UNION
    SELECT companion.id
    FROM kc_upload_versions d
    JOIN data_sources companion
      ON companion.type = 'json'::data_source_type
     AND companion.metadata->>'s3_bucket' = d.metadata->>'companion_s3_bucket'
     AND companion.metadata->>'s3_key' = d.metadata->>'companion_s3_key'
    WHERE d.rn > 1;

    DELETE FROM ingestion_runs
    WHERE data_source_id IN (SELECT id FROM kc_superseded_ids);

    DELETE FROM data_sources
    WHERE id IN (SELECT id FROM kc_superseded_ids);

    DELETE FROM sources s
    WHERE s.url IN (SELECT url FROM kc_upload_versions WHERE rn > 1 AND url IS NOT NULL)
      AND s.source_type = ANY(ARRAY['document', 'video']::source_type[])
      AND NOT EXISTS (
        SELECT 1
        FROM data_sources ds
        WHERE ds.type = ANY(ARRAY['csv', 'markdown', 'document', 'video']::data_source_type[])
          AND ${DATA_SOURCE_URL_SQL} = s.url
      );
  `);
};

exports.down = () => {
  // Not reversible — the deleted rows were superseded versions of files that
  // are still present under their newest upload.
};
