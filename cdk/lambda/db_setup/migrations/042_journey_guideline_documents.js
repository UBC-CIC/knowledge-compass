/**
 * 042_journey_guideline_documents.js
 *
 * Guides can belong to a journey. A journey may have many documents.
 * Situations stay unique across the ready documents of one journey; that
 * check runs when a file is read (guideline_document.py), not in the schema,
 * so replacing a file can keep the situations it already owns.
 *
 * journey_id is nullable: documents uploaded before this migration stay
 * unattached and are not used by a specific journey.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE guideline_documents
      ADD COLUMN IF NOT EXISTS journey_id uuid REFERENCES journeys(id) ON DELETE CASCADE;

    CREATE INDEX IF NOT EXISTS guideline_documents_journey_idx
      ON guideline_documents (journey_id)
      WHERE journey_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS guideline_documents_journey_idx;
    ALTER TABLE guideline_documents DROP COLUMN IF EXISTS journey_id;
  `);
};
