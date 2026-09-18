/**
 * 008_document_data_source_type.js
 *
 * Adds `document` to data_source_type so admins can upload a single PDF,
 * DOCX, or TXT file for direct chunk + embed (no metadata.json sidecar
 * required, unlike the existing csv/markdown pair flow).
 */

exports.up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`ALTER TYPE data_source_type ADD VALUE IF NOT EXISTS 'document';`);
};

exports.down = () => {
  // Enum values cannot be removed safely once in use.
};
