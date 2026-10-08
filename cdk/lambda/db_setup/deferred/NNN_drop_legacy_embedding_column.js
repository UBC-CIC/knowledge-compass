/**
 * NNN_drop_legacy_embedding_column.js
 *
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ DEFERRED. DO NOT MOVE INTO migrations/ UNTIL SEPARATELY APPROVED.             │
 * │ Prerequisites: tasks 5 and 6 (retrieval and writers on the active embedding   │
 * │ space) deployed AND verified in production, and the rollback window closed.   │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * What it does (up): removes the legacy single-model storage that migration 032 kept
 * for rollout compatibility:
 *   - trigger trg_chunks_mirror_legacy_embedding and function chunks_mirror_legacy_embedding()
 *   - index idx_chunks_embedding_hnsw (superseded by the per-space partial indexes)
 *   - column chunks.embedding
 * After this runs, vectors live only in chunk_embeddings (one row per chunk and space).
 *
 * Why it is not a normal migration:
 *   - It lives in db_setup/deferred/, which db_setup/index.js never reads: the runner's
 *     `dir` is db_setup/migrations/ only. Nothing in cdk/lib or cdk/bin refers to this file.
 *   - Its name starts with the placeholder `NNN_`, so it cannot be mistaken for the next
 *     zero-padded migration number or sorted into the sequence.
 *   - `up` refuses to run unless KC_DEFERRED_MIGRATION_APPROVED is set to
 *     "drop-legacy-embedding-column" (see APPROVAL_VALUE). So even a file moved by
 *     mistake fails the pipeline instead of dropping a column. When the change is
 *     approved, whoever moves it also deletes this guard in the same reviewed commit.
 *   - `up` also refuses if any chunk still has a legacy vector that the legacy space
 *     (cohere-v3-1024) does not hold, so the drop cannot lose data that exists nowhere else.
 *
 * Down (always allowed, no approval needed): restores the column as vector(1024),
 * backfills it from the legacy space's CURRENT vectors (embed_hash = md5(embed_text); a
 * vector made from older text is never copied back), then recreates the HNSW index
 * (same definition as migration 011), the mirror function and the trigger from 032.
 * The backfill runs before the index and the trigger exist, so it is not slowed down by
 * the index or echoed back by the trigger. Only vectors of the legacy 1024-dimension
 * space can come back; vectors of other spaces have no home in the old column.
 *
 * Applied manually (or via the Docker harness: docker_migration_check.js --deferred),
 * never by the deploy pipeline.
 */

const APPROVAL_ENV = "KC_DEFERRED_MIGRATION_APPROVED";
const APPROVAL_VALUE = "drop-legacy-embedding-column";
const LEGACY_SPACE = "cohere-v3-1024";

exports.up = (pgm) => {
  if (process.env[APPROVAL_ENV] !== APPROVAL_VALUE) {
    throw new Error(
      `Deferred migration NNN_drop_legacy_embedding_column is not approved. ` +
        `It drops chunks.embedding. Read db_setup/deferred/README.md, then set ${APPROVAL_ENV}=${APPROVAL_VALUE} ` +
        `only after the approval gate is met.`,
    );
  }
  pgm.sql(`
    -- Refuse to drop vectors that exist nowhere else.
    DO $$
    DECLARE
      v_missing bigint;
    BEGIN
      SELECT count(*) INTO v_missing
        FROM chunks c
       WHERE c.embedding IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM chunk_embeddings ce
             JOIN embedding_spaces s ON s.id = ce.space_id
            WHERE ce.chunk_id = c.id AND s.name = '${LEGACY_SPACE}'
         );
      IF v_missing > 0 THEN
        RAISE EXCEPTION '% chunks have a legacy vector that the % space does not hold; not dropping chunks.embedding',
          v_missing, '${LEGACY_SPACE}';
      END IF;
    END
    $$;

    DROP TRIGGER IF EXISTS trg_chunks_mirror_legacy_embedding ON chunks;
    DROP FUNCTION IF EXISTS chunks_mirror_legacy_embedding();
    DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;
    ALTER TABLE chunks DROP COLUMN IF EXISTS embedding;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- 1. Restore the column.
    ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding vector(1024);

    -- 2. Backfill it from the legacy space's current vectors (before the index and the
    --    trigger exist). Stale vectors (text changed since) are not copied back.
    UPDATE chunks c
       SET embedding = ce.embedding::vector(1024)
      FROM chunk_embeddings ce
      JOIN embedding_spaces s ON s.id = ce.space_id
     WHERE s.name = '${LEGACY_SPACE}'
       AND s.dimensions = 1024
       AND ce.chunk_id = c.id
       AND ce.embed_hash = md5(c.embed_text)
       AND c.embedding IS NULL;

    -- 3. Restore the index (same definition as migration 011).
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
      ON chunks USING hnsw (embedding vector_cosine_ops);

    -- 4. Restore the compatibility mirror from migration 032.
    CREATE OR REPLACE FUNCTION chunks_mirror_legacy_embedding() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
    AS $fn$
    DECLARE
      v_space uuid;
    BEGIN
      SELECT id INTO v_space FROM embedding_spaces WHERE name = '${LEGACY_SPACE}';
      IF v_space IS NOT NULL THEN
        INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash, embedded_at)
        VALUES (NEW.id, v_space, NEW.embedding, md5(NEW.embed_text), now())
        ON CONFLICT (chunk_id, space_id) DO UPDATE
          SET embedding   = EXCLUDED.embedding,
              embed_hash  = EXCLUDED.embed_hash,
              embedded_at = EXCLUDED.embedded_at;
      END IF;
      RETURN NULL;
    END
    $fn$;

    DROP TRIGGER IF EXISTS trg_chunks_mirror_legacy_embedding ON chunks;
    CREATE TRIGGER trg_chunks_mirror_legacy_embedding
      AFTER INSERT OR UPDATE OF embedding ON chunks
      FOR EACH ROW
      WHEN (NEW.embedding IS NOT NULL)
      EXECUTE FUNCTION chunks_mirror_legacy_embedding();
  `);
};

exports.APPROVAL_ENV = APPROVAL_ENV;
exports.APPROVAL_VALUE = APPROVAL_VALUE;
