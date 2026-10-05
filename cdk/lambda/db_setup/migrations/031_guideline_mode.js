/**
 * 031_guideline_mode.js
 *
 * Guideline mode: an alternative, test-alongside response pipeline in which
 * admins upload Markdown guidance documents and the assistant answers only
 * from the best-matching section. It does not change or replace the existing
 * prompt system (system_messages, system_settings, journeys 024).
 *
 *   guideline_config     single row; prompt_mode 'standard' | 'guideline'
 *                        selects which pipeline textGeneration uses.
 *   guideline_documents  one row per uploaded file and its ingestion status.
 *   guideline_sections   one row per auto-detected situation/section, with
 *                        an optional admin label override.
 *
 * Chunks live in the existing sources/chunks tables under one hidden source
 * per document (url guideline://doc/{id}, metadata.kb_role = 'guideline',
 * metadata.retrieval_hidden = 'true'), so standard retrieval never sees them.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS guideline_config (
      id           integer       PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      prompt_mode  varchar(16)   NOT NULL DEFAULT 'standard'
                                 CHECK (prompt_mode IN ('standard', 'guideline')),
      updated_by   varchar(320),
      updated_at   timestamptz   NOT NULL DEFAULT now()
    );

    INSERT INTO guideline_config (id, prompt_mode)
    VALUES (1, 'standard')
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS guideline_documents (
      id             uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
      file_name      varchar(255)  NOT NULL,
      s3_key         text          NOT NULL,
      uploaded_by    varchar(320),
      status         varchar(16)   NOT NULL DEFAULT 'processing'
                                   CHECK (status IN ('processing', 'ready', 'failed')),
      error          text,
      section_count  integer       NOT NULL DEFAULT 0,
      created_at     timestamptz   NOT NULL DEFAULT now(),
      updated_at     timestamptz   NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS guideline_sections (
      id              uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
      document_id     uuid          NOT NULL REFERENCES guideline_documents(id) ON DELETE CASCADE,
      section_key     varchar(512)  NOT NULL,
      heading_path    text,
      content_hash    varchar(64),
      auto_label      varchar(120)  NOT NULL,
      label_override  varchar(120),
      summary         text,
      sort_order      integer       NOT NULL DEFAULT 0,
      created_at      timestamptz   NOT NULL DEFAULT now(),
      updated_at      timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT guideline_sections_document_key UNIQUE (document_id, section_key)
    );

    CREATE INDEX IF NOT EXISTS guideline_sections_document_idx
      ON guideline_sections (document_id, sort_order);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM sources WHERE metadata->>'kb_role' = 'guideline';
    DROP TABLE IF EXISTS guideline_sections;
    DROP TABLE IF EXISTS guideline_documents;
    DROP TABLE IF EXISTS guideline_config;
  `);
};
