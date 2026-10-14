/**
 * 034_service_status.js
 *
 * Maintenance banner and read-only fallback, controlled from the admin
 * "Assistant settings" page (no deploy needed).
 *
 *   system_settings.service_status   'normal' (default), 'banner' or 'read_only'
 *   system_settings.service_message  short text written by an operator, shown to families
 *                                    (up to 500 characters; NULL when unused)
 *
 *   normal     nothing changes
 *   banner     families see the message above the chat; chat keeps working
 *   read_only  families see the message, the message box is disabled and a new
 *              chat turn is refused with a clear error (textGeneration main.py)
 *
 * Existing rows take 'normal' from the column DEFAULT, so the NOT NULL needs no
 * backfill. The CHECK constraints use the guarded pg_constraint pattern of
 * migration 022, so the migration can be re-applied.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS service_status  varchar(16) NOT NULL DEFAULT 'normal',
      ADD COLUMN IF NOT EXISTS service_message text NULL;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_service_status_check') THEN
        ALTER TABLE system_settings
          ADD CONSTRAINT system_settings_service_status_check
          CHECK (service_status IN ('normal', 'banner', 'read_only'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_service_message_check') THEN
        ALTER TABLE system_settings
          ADD CONSTRAINT system_settings_service_message_check
          CHECK (char_length(service_message) <= 500);
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings
      DROP CONSTRAINT IF EXISTS system_settings_service_message_check,
      DROP CONSTRAINT IF EXISTS system_settings_service_status_check,
      DROP COLUMN IF EXISTS service_message,
      DROP COLUMN IF EXISTS service_status;
  `);
};
