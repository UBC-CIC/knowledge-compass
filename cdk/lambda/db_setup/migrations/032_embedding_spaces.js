/**
 * 032_embedding_spaces.js
 *
 * Makes the embedding model swappable. Vectors move from the single
 * `chunks.embedding` column into a side table keyed by an "embedding space"
 * (one model + dimension + version), so a new model can be built next to the
 * live one and activated by flipping a pointer.
 *
 *   embedding_spaces        one row per space (provider, invoke target, dimension,
 *                           lifecycle status, optional per-space min_score /
 *                           split_threshold / price / EOL date, JSON settings).
 *                           price_per_1m_tokens and eol_date are nullable on purpose:
 *                           model ids and prices are configuration, not facts
 *                           this migration asserts.
 *   embedding_active_space  single row; the space retrieval reads and writers
 *                           target. Also carries the cutover lock used by task 10.
 *   chunk_embeddings        (chunk_id, space_id) -> vector, with embed_hash =
 *                           md5(chunks.embed_text) so a vector is only trusted when
 *                           the text it was made from is still the chunk's text.
 *
 * Per-space HNSW index. `chunks.embedding` was vector(1024); the side table stores an
 * untyped `vector` so spaces of different dimensions can share one table. pgvector
 * only builds an index over a fixed dimension, so each space gets a PARTIAL
 * EXPRESSION index:
 *
 *   CREATE INDEX idx_ce_hnsw_<uuid without dashes> ON chunk_embeddings
 *     USING hnsw ((embedding::vector(N)) vector_cosine_ops) WHERE space_id = '<uuid>'
 *
 * Queries must use the same cast and a literal space id to use it. The index name is
 * derived from the space id by `create_space_index`; Python mirrors the rule in
 * helpers/embedding_space.py (`index_name`).
 *
 * create_space_index / drop_space_index are SECURITY DEFINER so the app role
 * (readwrite members) can register a space at runtime without owning the table. They
 * take a space id, never free text, read the dimension from the registry and quote
 * every identifier and literal.
 *
 * Rollout compatibility: the legacy space `cohere-v3-1024` is registered, active and
 * backfilled from `chunks.embedding`. Until the new writers ship, a trigger mirrors any
 * write to `chunks.embedding` into that legacy space only, so old code keeps the
 * legacy space current. The trigger and the old column/index are removed by the
 * separately approved cleanup migration, never here. `chunks.embedding` and
 * `idx_chunks_embedding_hnsw` are not touched in either direction.
 *
 * The backfill is one statement, fine at the current corpus size; a very large chunks
 * table would need it batched. Building the legacy partial index duplicates
 * idx_chunks_embedding_hnsw until that cleanup, intentionally.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS embedding_spaces (
      id                   uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
      name                 varchar(64)   NOT NULL UNIQUE,
      provider             varchar(32)   NOT NULL,
      model_id             text          NOT NULL,
      invoke_target        text          NOT NULL,
      dimensions           integer       NOT NULL CHECK (dimensions BETWEEN 1 AND 2000),
      version              varchar(32)   NOT NULL DEFAULT '1',
      status               varchar(16)   NOT NULL
                                         CHECK (status IN ('building', 'validated', 'active', 'retired', 'purged')),
      min_score            numeric(4,3)  NULL CHECK (min_score BETWEEN 0 AND 1),
      split_threshold      numeric(4,3)  NULL CHECK (split_threshold BETWEEN 0 AND 1),
      price_per_1m_tokens  numeric(12,4) NULL CHECK (price_per_1m_tokens >= 0),
      eol_date             date          NULL,
      settings             jsonb         NOT NULL DEFAULT '{}',
      created_by           varchar(320),
      created_at           timestamptz   NOT NULL DEFAULT now(),
      activated_at         timestamptz   NULL,
      retired_at           timestamptz   NULL
    );

    CREATE TABLE IF NOT EXISTS embedding_active_space (
      id                 integer      PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      space_id           uuid         NOT NULL REFERENCES embedding_spaces(id),
      cutover_locked     boolean      NOT NULL DEFAULT false,
      cutover_locked_at  timestamptz  NULL,
      cutover_job_id     uuid         NULL,
      updated_at         timestamptz  NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id     uuid         NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      space_id     uuid         NOT NULL REFERENCES embedding_spaces(id),
      embedding    vector       NOT NULL,
      embed_hash   char(32)     NOT NULL,
      embedded_at  timestamptz  NOT NULL DEFAULT now(),
      PRIMARY KEY (chunk_id, space_id)
    );

    -- Coverage counts and the "missing vectors" scan.
    CREATE INDEX IF NOT EXISTS chunk_embeddings_space_idx
      ON chunk_embeddings (space_id, chunk_id);

    -- ── Per-space index functions ───────────────────────────────────────────────
    CREATE OR REPLACE FUNCTION create_space_index(p_space_id uuid) RETURNS text
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $fn$
    DECLARE
      v_dims   integer;
      v_status varchar(16);
      v_name   text;
    BEGIN
      SELECT dimensions, status INTO v_dims, v_status
        FROM embedding_spaces WHERE id = p_space_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'embedding space % does not exist', p_space_id;
      END IF;
      IF v_status = 'purged' THEN
        RAISE EXCEPTION 'embedding space % is purged', p_space_id;
      END IF;
      v_name := 'idx_ce_hnsw_' || replace(p_space_id::text, '-', '');
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON chunk_embeddings USING hnsw ((embedding::vector(%s)) vector_cosine_ops) WHERE space_id = %L',
        v_name, v_dims, p_space_id
      );
      RETURN v_name;
    END
    $fn$;

    CREATE OR REPLACE FUNCTION drop_space_index(p_space_id uuid) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $fn$
    DECLARE
      v_status varchar(16);
    BEGIN
      SELECT status INTO v_status FROM embedding_spaces WHERE id = p_space_id;
      IF v_status = 'active' THEN
        RAISE EXCEPTION 'embedding space % is active; its index cannot be dropped', p_space_id;
      END IF;
      EXECUTE format('DROP INDEX IF EXISTS %I', 'idx_ce_hnsw_' || replace(p_space_id::text, '-', ''));
    END
    $fn$;

    REVOKE ALL ON FUNCTION create_space_index(uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION drop_space_index(uuid) FROM PUBLIC;

    -- The readwrite role is created by db_setup/index.js AFTER migrations on a
    -- brand-new database; that file repeats this grant for that case.
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readwrite') THEN
        GRANT EXECUTE ON FUNCTION create_space_index(uuid), drop_space_index(uuid) TO readwrite;
      END IF;
    END
    $$;

    -- ── Legacy space, pointer and backfill ──────────────────────────────────────
    INSERT INTO embedding_spaces
      (name, provider, model_id, invoke_target, dimensions, status, min_score, split_threshold, activated_at)
    VALUES
      ('cohere-v3-1024', 'cohere_v3', 'cohere.embed-english-v3', 'cohere.embed-english-v3',
       1024, 'active', 0.40, 0.6, now())
    ON CONFLICT (name) DO NOTHING;

    INSERT INTO embedding_active_space (id, space_id)
    SELECT 1, id FROM embedding_spaces WHERE name = 'cohere-v3-1024'
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash, embedded_at)
    SELECT c.id, s.id, c.embedding, md5(c.embed_text), now()
      FROM chunks c
      CROSS JOIN (SELECT id FROM embedding_spaces WHERE name = 'cohere-v3-1024') s
     WHERE c.embedding IS NOT NULL
    ON CONFLICT (chunk_id, space_id) DO NOTHING;

    SELECT create_space_index(id) FROM embedding_spaces WHERE name = 'cohere-v3-1024';

    -- ── Compatibility trigger (removed by the deferred cleanup migration) ───────
    -- Mirrors writes to the legacy chunks.embedding column into the LEGACY space only
    -- (looked up by name, never through the active pointer).
    CREATE OR REPLACE FUNCTION chunks_mirror_legacy_embedding() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
    AS $fn$
    DECLARE
      v_space uuid;
    BEGIN
      SELECT id INTO v_space FROM embedding_spaces WHERE name = 'cohere-v3-1024';
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

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_chunks_mirror_legacy_embedding ON chunks;
    DROP FUNCTION IF EXISTS chunks_mirror_legacy_embedding();

    DO $$
    DECLARE
      r record;
    BEGIN
      FOR r IN
        SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'chunk_embeddings'
           AND starts_with(indexname, 'idx_ce_hnsw_')
      LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname);
      END LOOP;
    END
    $$;

    DROP FUNCTION IF EXISTS create_space_index(uuid);
    DROP FUNCTION IF EXISTS drop_space_index(uuid);

    DROP TABLE IF EXISTS chunk_embeddings;
    DROP TABLE IF EXISTS embedding_active_space;
    DROP TABLE IF EXISTS embedding_spaces;
  `);
};
