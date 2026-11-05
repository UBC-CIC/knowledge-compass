/**
 * 050_system_messages_one_active.js
 *
 * At most one active system_messages row per type (finding f-e1a8b540).
 * Until now only uq_system_messages_type_version (migration 000) existed, so a
 * create racing an activate could leave two active rows; readers then serve
 * the higher version (textGeneration/helpers/crud.py) and an admin rollback to
 * an older version silently has no effect. journey_prompt_versions has had the
 * same partial unique index since migration 024.
 *
 * Changes:
 *   1. Lock the table against concurrent writes for the rest of the migration
 *      transaction (reads are not blocked).
 *   2. Repair: where a type has more than one active row, keep the newest
 *      version active (the one readers already serve, so the live prompt does
 *      not change) and deactivate the others. No row is deleted.
 *   3. CREATE UNIQUE INDEX uq_system_messages_active ON system_messages (type)
 *      WHERE is_active. The admin handler deactivates before it inserts or
 *      activates, in one transaction, and maps a unique violation to 409.
 *
 * Down drops the index only; deactivated duplicates stay inactive.
 */

exports.up = (pgm) => {
  pgm.sql(`
    LOCK TABLE system_messages IN SHARE ROW EXCLUSIVE MODE;

    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY type ORDER BY version DESC, created_at DESC NULLS LAST, id DESC
             ) AS rn
        FROM system_messages
       WHERE is_active
    )
    UPDATE system_messages sm
       SET is_active = false
      FROM ranked r
     WHERE sm.id = r.id
       AND r.rn > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_system_messages_active
      ON system_messages (type)
      WHERE is_active;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS uq_system_messages_active;
  `);
};
