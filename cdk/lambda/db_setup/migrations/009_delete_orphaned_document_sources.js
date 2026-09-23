/**
 * 009_delete_orphaned_document_sources.js
 *
 * One-time cleanup: before delete_data_source.py removed the pgvector
 * `sources` row for csv/markdown/document uploads, deleting one of those data
 * sources left its chunks in place, still served by retrieval. That gap is now
 * closed going forward, so this only removes the orphans left from before.
 *
 * A 'document' source is orphaned when no remaining csv/markdown/document data
 * source maps to its url, using the same mapping process_document_batch.py
 * writes: a document's `document_url` when set, otherwise `s3://bucket/key`.
 * Chunks are removed by the ON DELETE CASCADE on chunks.source_id.
 */

exports.up = async (pgm) => {
  await pgm.sql(`
    DELETE FROM sources s
    WHERE s.source_type = 'document'::source_type
      AND NOT EXISTS (
        SELECT 1
        FROM data_sources ds
        WHERE ds.type = ANY(ARRAY['csv', 'markdown', 'document']::data_source_type[])
          AND s.url = CASE
            WHEN ds.type = 'document'::data_source_type
             AND COALESCE(btrim(ds.metadata->>'document_url'), '') <> ''
              THEN btrim(ds.metadata->>'document_url')
            ELSE 's3://' || (ds.metadata->>'s3_bucket') || '/' || (ds.metadata->>'s3_key')
          END
      );
  `);
};

exports.down = () => {
  // Not reversible — the deleted chunks belonged to data sources that no longer exist.
};
