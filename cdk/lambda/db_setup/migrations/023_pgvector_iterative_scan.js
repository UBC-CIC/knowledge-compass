/**
 * 023_pgvector_iterative_scan.js
 *
 * Brings the `vector` extension up to the version the RDS engine ships, so
 * textGeneration/helpers/retrieval.py can use HNSW iterative index scans
 * (hnsw.iterative_scan, pgvector >= 0.8.0).
 *
 * Why: an HNSW scan returns at most hnsw.ef_search rows (default 40), and the
 * retrieval filters (retrieval_hidden, unindexed CSV rows) plus per-source
 * de-duplication run after the scan. retrieval.py asks for up to 120
 * candidates per page and pages with OFFSET, which only works when the scan
 * can continue past ef_search. The comment in 011 ("<= 21 candidates") is
 * stale; this migration and retrieval.py supersede it.
 *
 * An existing database keeps the extension version it was created with until
 * ALTER EXTENSION ... UPDATE runs, even after an engine minor upgrade.
 *
 * Older pgvector does not fail the migration: retrieval.py applies the
 * iterative-scan setting inside a savepoint and falls back to ef_search only.
 * A WARNING is raised instead so the gap shows up in the db_setup logs.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER EXTENSION vector UPDATE;

    DO $$
    DECLARE
      installed text;
    BEGIN
      SELECT extversion INTO installed FROM pg_extension WHERE extname = 'vector';
      IF installed IS NULL THEN
        RAISE WARNING 'pgvector extension is not installed';
      ELSIF string_to_array(split_part(installed, '-', 1), '.')::int[] < ARRAY[0, 8, 0] THEN
        RAISE WARNING 'pgvector % is older than 0.8.0; HNSW iterative scans are unavailable. Upgrade the RDS engine minor version, then re-run ALTER EXTENSION vector UPDATE.', installed;
      ELSE
        RAISE NOTICE 'pgvector % supports HNSW iterative scans', installed;
      END IF;
    END $$;
  `);
};

// Extension downgrades are not supported; leaving the newer version in place
// is backwards compatible with the previous retrieval code.
exports.down = () => {};
