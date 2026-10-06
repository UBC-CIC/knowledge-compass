/**
 * 015_csv_link_source_type.js
 *
 * Adds `csv_link` to source_type: web pages / PDFs linked from a CSV's
 * url_column, fetched and indexed by helpers/process_csv_links.py. They get
 * their own type (not 'web') so cleanup of CSV-linked content can never touch
 * pages indexed by the website crawler.
 *
 * Separate from 016 because ALTER TYPE ... ADD VALUE must run outside a
 * transaction.
 */

exports.up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'csv_link';`);
};

exports.down = () => {
  // Enum values cannot be removed safely once in use.
};
