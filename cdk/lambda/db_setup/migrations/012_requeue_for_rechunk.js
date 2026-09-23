/**
 * 012_requeue_for_rechunk.js
 *
 * One-time requeue: document and website chunks were capped at 650 words, which
 * runs past the 2048-char Cohere input limit, so only the first ~2048 chars of
 * each chunk were embedded. process_document_batch.py and the crawler now cap
 * chunks at 300 words; this re-ingests existing sources at the new size.
 *
 * Inserts a 'pending' ingestion run for every document/website data source
 * whose latest run completed. Nothing starts here — an admin clicks Sync now
 * (start_ingestion_job) to promote them to 'queued' and run them, after the
 * updated knowledge base Lambda and crawler image are deployed. Documents are
 * re-read from their S3 key, so nothing needs to be re-uploaded; changed chunks
 * are re-embedded and leftover chunk indices are deleted.
 *
 * Sources whose latest run is pending/queued/running will already pick up the
 * new chunk size, and failed ones are left to the admin Retry flow.
 */

exports.up = async (pgm) => {
  await pgm.sql(`
    WITH latest_runs AS (
      SELECT DISTINCT ON (ir.data_source_id) ir.data_source_id, ir.status
      FROM ingestion_runs ir
      ORDER BY ir.data_source_id, ir.created_at DESC, ir.id DESC
    )
    INSERT INTO ingestion_runs (data_source_id, status, metadata)
    SELECT ds.id, 'pending'::ingestion_status, '{"action": "rechunk_300_words"}'::jsonb
    FROM data_sources ds
    JOIN latest_runs lr ON lr.data_source_id = ds.id
    WHERE ds.type = ANY(ARRAY['document', 'website']::data_source_type[])
      AND lr.status = 'completed'::ingestion_status;
  `);
};

exports.down = async (pgm) => {
  // Remove only the requeued runs that were never synced.
  await pgm.sql(`
    DELETE FROM ingestion_runs
    WHERE status = 'pending'::ingestion_status
      AND metadata->>'action' = 'rechunk_300_words';
  `);
};
