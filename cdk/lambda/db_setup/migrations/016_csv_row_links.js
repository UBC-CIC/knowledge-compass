/**
 * 016_csv_row_links.js
 *
 * One row per CSV row whose url_column holds a link (see helpers/csv_links.py):
 * which row it is, the link, the row's other columns, and the per-row crawl
 * status (pending / success / failed / skipped + reason).
 *
 * The fetched content itself lives in `sources` under source_url
 * ('csvlink://' || normalized_url, source_type 'csv_link'), shared by every
 * row (in any CSV) that links to the same normalized URL, so each URL is
 * stored and embedded once. A csv_link source is deleted once no row
 * references it any more. Rows cascade with their CSV data source.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS csv_row_links (
      id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      data_source_id  uuid          NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
      row_key         varchar(128)  NOT NULL,
      row_number      int           NOT NULL,
      raw_url         text          NOT NULL,
      normalized_url  varchar(2000),
      source_url      varchar(2048),
      row_metadata    jsonb         NOT NULL DEFAULT '{}',
      status          varchar(16)   NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
      reason          text,
      http_status     int,
      content_type    varchar(255),
      fetched_at      timestamptz,
      created_at      timestamptz   NOT NULL DEFAULT now(),
      updated_at      timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT uq_csv_row_links_row UNIQUE (data_source_id, row_key)
    );

    CREATE INDEX IF NOT EXISTS idx_csv_row_links_source_url ON csv_row_links(source_url);
    CREATE INDEX IF NOT EXISTS idx_csv_row_links_status ON csv_row_links(data_source_id, status);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM sources WHERE source_type = 'csv_link'::source_type;
    DROP TABLE IF EXISTS csv_row_links;
  `);
};
