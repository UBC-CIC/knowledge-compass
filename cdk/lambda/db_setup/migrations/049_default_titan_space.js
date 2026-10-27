/**
 * 049_default_titan_space.js
 *
 * Makes Amazon Titan Text Embeddings V2 (1024 dimensions) the embedding model of a
 * NEW install. Cohere Embed English v3, which migration 032 registers as the legacy
 * active space, is end of life.
 *
 * Only a database with no content is switched: when the active space is still the
 * legacy `cohere-v3-1024` and both `chunks` and `chunk_embeddings` are empty, this
 *   1. registers `titan-v2-1024` (provider titan_v2, model and invoke target
 *      amazon.titan-embed-text-v2:0) as active and builds its partial HNSW index;
 *   2. retires `cohere-v3-1024` (kept, so the admin console can still roll back);
 *   3. points embedding_active_space at the Titan space.
 *
 * A database that already holds content is left exactly as it is. Its vectors were
 * made by Cohere v3, and Titan V2 at 1024 dimensions has the same vector size, so a
 * silent switch would search Cohere vectors with Titan queries and return wrong
 * matches with no error. Those deployments move with a rebuild and cutover from the
 * admin console (Docs/runbooks/embedding-model-swap.md).
 *
 * min_score and split_threshold are left NULL, so the code defaults apply. They were
 * tuned for Cohere v3; tune them for Titan with the golden-set evaluation.
 *
 * Down undoes the switch only while the Titan space is still active and holds no
 * vectors; otherwise it changes nothing.
 */

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE
      v_legacy uuid;
      v_titan  uuid;
    BEGIN
      SELECT a.space_id INTO v_legacy
        FROM embedding_active_space a
        JOIN embedding_spaces s ON s.id = a.space_id
       WHERE s.name = 'cohere-v3-1024';
      IF v_legacy IS NULL THEN
        RETURN;  -- another space is already active
      END IF;
      IF EXISTS (SELECT 1 FROM chunks) OR EXISTS (SELECT 1 FROM chunk_embeddings) THEN
        RETURN;  -- existing content: switch through the admin console instead
      END IF;

      INSERT INTO embedding_spaces
        (name, provider, model_id, invoke_target, dimensions, status, activated_at)
      VALUES
        ('titan-v2-1024', 'titan_v2', 'amazon.titan-embed-text-v2:0', 'amazon.titan-embed-text-v2:0',
         1024, 'active', now())
      ON CONFLICT (name) DO NOTHING
      RETURNING id INTO v_titan;
      IF v_titan IS NULL THEN
        RETURN;  -- the name is taken by a space someone registered; leave it alone
      END IF;

      PERFORM create_space_index(v_titan);

      UPDATE embedding_spaces SET status = 'retired', retired_at = now() WHERE id = v_legacy;
      UPDATE embedding_active_space SET space_id = v_titan, updated_at = now() WHERE id = 1;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE
      v_legacy uuid;
      v_titan  uuid;
    BEGIN
      SELECT a.space_id INTO v_titan
        FROM embedding_active_space a
        JOIN embedding_spaces s ON s.id = a.space_id
       WHERE s.name = 'titan-v2-1024';
      SELECT id INTO v_legacy FROM embedding_spaces WHERE name = 'cohere-v3-1024' AND status = 'retired';
      IF v_titan IS NULL OR v_legacy IS NULL THEN
        RETURN;
      END IF;
      IF EXISTS (SELECT 1 FROM chunk_embeddings WHERE space_id = v_titan)
         OR EXISTS (SELECT 1 FROM embedding_jobs WHERE space_id = v_titan) THEN
        RETURN;  -- the Titan space is in use; roll back from the admin console
      END IF;

      UPDATE embedding_spaces SET status = 'active', retired_at = NULL WHERE id = v_legacy;
      UPDATE embedding_active_space SET space_id = v_legacy, updated_at = now() WHERE id = 1;
      UPDATE embedding_spaces SET status = 'retired', retired_at = now() WHERE id = v_titan;
      PERFORM drop_space_index(v_titan);
      DELETE FROM embedding_spaces WHERE id = v_titan;
    END
    $$;
  `);
};
