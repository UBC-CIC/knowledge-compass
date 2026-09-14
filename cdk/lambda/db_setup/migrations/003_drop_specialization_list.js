/**
 * 003_drop_specialization_list.js
 *
 * Cleanup for the pgvector migration (item R4; see
 * Project Refactoring/PGVECTOR_MIGRATION_PLAN.md).
 *
 * Removes the UBC-specific `specialization_list` column from `system_settings`.
 * As of Phase 3 the application no longer reads this column (config.load_config
 * stopped consuming it), and crud.fetch_system_config stops SELECTing it in the
 * same change set. Dropping it removes the last UBC-domain data artifact from the
 * settings table.
 *
 * The `down` re-adds the column as a nullable text[] with no data. The original
 * UBC seed values are intentionally NOT restored (they are irrelevant to the
 * Inclusion Canada product and remain available in git history / migration 000).
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings DROP COLUMN IF EXISTS specialization_list;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS specialization_list text[];
  `);
};
