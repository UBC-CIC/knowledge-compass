/**
 * 001_unified_chunks.js
 *
 * Phase 1 of the pgvector migration (see Project Refactoring/PGVECTOR_MIGRATION_PLAN.md).
 *
 * Adds the unified retrieval corpus used by the crawler, the transcriber, and the
 * text-generation retrieval path:
 *   - sources : one row per ingested source (web page, video, or document)
 *   - chunks  : one row per embedded text chunk (Cohere embed-english-v3, 1024-dim)
 *
 * Also extends the existing `ingestion_runs` table into the single unified
 * ingestion-run model (adds source linkage, timing, and crawl counters) so we do
 * NOT introduce separate crawl_runs / video_* tables.
 *
 * The `vector` and `uuid-ossp` extensions are already created by 000_initial_schema.js.
 *
 * Contract this schema must satisfy (do not rename columns without updating callers):
 *   sources: id, name, url (unique), source_type, created_at, updated_at, metadata
 *   chunks:  id, source_id, chunk_index, body, embed_text, word_count,
 *            content_hash, embedding vector(1024), metadata, created_at, updated_at
 *            unique (source_id, chunk_index)
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- Safety: extensions are created in 000, but keep this idempotent.
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "vector";

    -- ==============================
    -- ENUM: source_type (web | video | document)
    -- ==============================
    DO $$ BEGIN
      CREATE TYPE source_type AS ENUM ('web', 'video', 'document');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    -- ==============================
    -- TABLE: sources
    -- One row per ingested source. url is the canonical citation URL and is the
    -- upsert conflict target used by the crawler and transcriber.
    -- ==============================
    CREATE TABLE IF NOT EXISTS sources (
      id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      name        varchar(1024) NOT NULL,
      url         varchar(2048) NOT NULL,
      source_type source_type   NOT NULL,
      created_at  timestamptz   NOT NULL DEFAULT now(),
      updated_at  timestamptz   NOT NULL DEFAULT now(),
      metadata    jsonb         NOT NULL DEFAULT '{}'
    );

    DO $$ BEGIN
      ALTER TABLE sources ADD CONSTRAINT uq_sources_url UNIQUE (url);
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    -- ==============================
    -- TABLE: chunks
    -- One row per embedded chunk. embedding is a 1024-dim Cohere embed-english-v3
    -- vector. embed_text is the text actually embedded (may include heading path
    -- or video title/timestamp prefix); body is the human-readable chunk.
    -- ==============================
    CREATE TABLE IF NOT EXISTS chunks (
      id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      source_id    uuid         NOT NULL,
      chunk_index  int          NOT NULL,
      body         text         NOT NULL,
      embed_text   text         NOT NULL,
      word_count   int          NOT NULL DEFAULT 0,
      content_hash varchar(64)  NOT NULL,
      embedding    vector(1024),
      metadata     jsonb        NOT NULL DEFAULT '{}',
      created_at   timestamptz  NOT NULL DEFAULT now(),
      updated_at   timestamptz  NOT NULL DEFAULT now()
    );

    DO $$ BEGIN
      ALTER TABLE chunks
        ADD CONSTRAINT fk_chunks_source_id
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
      ALTER TABLE chunks
        ADD CONSTRAINT uq_chunks_source_chunk UNIQUE (source_id, chunk_index);
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    -- ==============================
    -- INDEXES
    -- ==============================
    CREATE INDEX IF NOT EXISTS idx_chunks_source_id ON chunks(source_id);
    CREATE INDEX IF NOT EXISTS idx_sources_source_type ON sources(source_type);

    -- Vector similarity index (cosine). IVFFlat is chosen for lowest cost/memory
    -- on a small corpus. IVFFlat only accelerates queries once the table has data
    -- and ANALYZE has run; for an empty/small table it is harmless. Revisit HNSW
    -- (better recall/latency, higher build cost) if the corpus grows. Tune 'lists'
    -- to roughly sqrt(rows); 100 is a reasonable starting default for a small corpus.
    DO $$ BEGIN
      CREATE INDEX idx_chunks_embedding_ivfflat
        ON chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
    EXCEPTION WHEN duplicate_table THEN null; END $$;

    -- ==============================
    -- Extend ingestion_runs into the unified ingestion-run model.
    -- The base table (id, data_source_id, status, error_message, created_at,
    -- completed_at, metadata) is created in 000. Add source linkage + crawl
    -- counters so a single table tracks web/video/document runs.
    -- ==============================
    ALTER TABLE ingestion_runs ADD COLUMN IF NOT EXISTS source_id       uuid;
    ALTER TABLE ingestion_runs ADD COLUMN IF NOT EXISTS started_at      timestamptz;
    ALTER TABLE ingestion_runs ADD COLUMN IF NOT EXISTS finished_at     timestamptz;
    ALTER TABLE ingestion_runs ADD COLUMN IF NOT EXISTS pages_crawled   int NOT NULL DEFAULT 0;
    ALTER TABLE ingestion_runs ADD COLUMN IF NOT EXISTS pages_skipped   int NOT NULL DEFAULT 0;
    ALTER TABLE ingestion_runs ADD COLUMN IF NOT EXISTS chunks_upserted int NOT NULL DEFAULT 0;
    ALTER TABLE ingestion_runs ADD COLUMN IF NOT EXISTS chunks_deleted  int NOT NULL DEFAULT 0;

    DO $$ BEGIN
      ALTER TABLE ingestion_runs
        ADD CONSTRAINT fk_ingestion_runs_source_id
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    CREATE INDEX IF NOT EXISTS idx_ingestion_runs_source_id ON ingestion_runs(source_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Reverse ingestion_runs extensions (leave the base table from 000 intact).
    DROP INDEX IF EXISTS idx_ingestion_runs_source_id;

    DO $$ BEGIN
      ALTER TABLE ingestion_runs DROP CONSTRAINT IF EXISTS fk_ingestion_runs_source_id;
    EXCEPTION WHEN undefined_object THEN null; END $$;

    ALTER TABLE ingestion_runs DROP COLUMN IF EXISTS chunks_deleted;
    ALTER TABLE ingestion_runs DROP COLUMN IF EXISTS chunks_upserted;
    ALTER TABLE ingestion_runs DROP COLUMN IF EXISTS pages_skipped;
    ALTER TABLE ingestion_runs DROP COLUMN IF EXISTS pages_crawled;
    ALTER TABLE ingestion_runs DROP COLUMN IF EXISTS finished_at;
    ALTER TABLE ingestion_runs DROP COLUMN IF EXISTS started_at;
    ALTER TABLE ingestion_runs DROP COLUMN IF EXISTS source_id;

    -- Drop retrieval corpus (chunks first due to FK).
    DROP TABLE IF EXISTS chunks CASCADE;
    DROP TABLE IF EXISTS sources CASCADE;

    DROP TYPE IF EXISTS source_type;
  `);
};
