/**
 * 017_csv_row_resources.js
 *
 * Expands CSV link rows into independently searchable resources. Each row can
 * own a csvrow:// source while the fetched csvlink:// source remains the
 * canonical, shared fetch cache. The migration is additive so older Lambda
 * code can continue to operate while the application deployment rolls out.
 *
 * PostgreSQL enum values cannot be safely removed in a down migration. The
 * down path deletes csv_row sources and removes the additive columns, but
 * intentionally leaves the csv_row enum value in place.
 */

exports.up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`
    ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'csv_row';

    ALTER TABLE csv_row_links
      ADD COLUMN IF NOT EXISTS raw_citation_url       text,
      ADD COLUMN IF NOT EXISTS citation_url           varchar(2000),
      ADD COLUMN IF NOT EXISTS citation_warning       text,
      ADD COLUMN IF NOT EXISTS title                  varchar(1024),
      ADD COLUMN IF NOT EXISTS description            text,
      ADD COLUMN IF NOT EXISTS row_text               text,
      ADD COLUMN IF NOT EXISTS resource_hash          varchar(64),
      ADD COLUMN IF NOT EXISTS row_source_id           uuid,
      ADD COLUMN IF NOT EXISTS row_indexed             boolean,
      ADD COLUMN IF NOT EXISTS fetched_content_indexed boolean,
      ADD COLUMN IF NOT EXISTS indexing_reason         text,
      ADD COLUMN IF NOT EXISTS indexed_at              timestamptz;

    -- Existing link rows previously cited their normalized fetch URL.
    UPDATE csv_row_links
    SET citation_url = normalized_url
    WHERE citation_url IS NULL;

    UPDATE csv_row_links
    SET row_indexed = false
    WHERE row_indexed IS NULL;

    UPDATE csv_row_links
    SET fetched_content_indexed = false
    WHERE fetched_content_indexed IS NULL;

    ALTER TABLE csv_row_links
      ALTER COLUMN row_indexed SET DEFAULT false,
      ALTER COLUMN row_indexed SET NOT NULL,
      ALTER COLUMN fetched_content_indexed SET DEFAULT false,
      ALTER COLUMN fetched_content_indexed SET NOT NULL;

    DO $$ BEGIN
      ALTER TABLE csv_row_links
        ADD CONSTRAINT fk_csv_row_links_row_source_id
        FOREIGN KEY (row_source_id) REFERENCES sources(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    CREATE INDEX IF NOT EXISTS idx_csv_row_links_row_source_id
      ON csv_row_links(row_source_id);
    CREATE INDEX IF NOT EXISTS idx_csv_row_links_index_pending
      ON csv_row_links(data_source_id, indexed_at)
      WHERE indexed_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`
    DELETE FROM sources WHERE source_type = 'csv_row'::source_type;

    DROP INDEX IF EXISTS idx_csv_row_links_index_pending;
    DROP INDEX IF EXISTS idx_csv_row_links_row_source_id;

    ALTER TABLE csv_row_links
      DROP CONSTRAINT IF EXISTS fk_csv_row_links_row_source_id,
      DROP COLUMN IF EXISTS indexed_at,
      DROP COLUMN IF EXISTS indexing_reason,
      DROP COLUMN IF EXISTS fetched_content_indexed,
      DROP COLUMN IF EXISTS row_indexed,
      DROP COLUMN IF EXISTS row_source_id,
      DROP COLUMN IF EXISTS resource_hash,
      DROP COLUMN IF EXISTS row_text,
      DROP COLUMN IF EXISTS description,
      DROP COLUMN IF EXISTS title,
      DROP COLUMN IF EXISTS citation_warning,
      DROP COLUMN IF EXISTS citation_url,
      DROP COLUMN IF EXISTS raw_citation_url;

    -- source_type value 'csv_row' intentionally remains; PostgreSQL does not
    -- support removing a single enum value safely.
  `);
};
