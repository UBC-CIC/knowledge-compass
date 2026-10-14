/**
 * 036_global_daily_budget.js
 *
 * Service-wide daily message budget for public chat
 * (textGeneration/helpers/message_limits.py: reserve_daily_characters).
 * Per-user limits alone do not bound cost, because anonymous identities are
 * cheap to create; this caps the total number of messages per UTC day.
 *
 * Changes:
 *   1. system_settings gains max_messages_per_day_global (default 5000), the
 *      number of messages all public users together can send per UTC calendar
 *      day. Admin-editable through /admin/system-settings.
 *   2. New table global_daily_usage: one row per UTC date holding only the
 *      running message count (no user id, no message text). It is incremented
 *      with an atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE in the same
 *      transaction as the per-user reservation and its request-id claim
 *      (daily_usage_requests, migration 034), so concurrent messages cannot
 *      overshoot the budget and a retried invocation is not counted twice.
 *
 * Keep the default in sync with helpers/config.py (MAX_MESSAGES_PER_DAY_GLOBAL),
 * the adminHandler GET fallback and frontend lib/assistantSettings.ts.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS max_messages_per_day_global integer NOT NULL DEFAULT 5000;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_max_messages_per_day_global_check') THEN
        ALTER TABLE system_settings
          ADD CONSTRAINT system_settings_max_messages_per_day_global_check CHECK (max_messages_per_day_global > 0);
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS global_daily_usage (
      usage_date  date        PRIMARY KEY,
      messages    integer     NOT NULL DEFAULT 0 CHECK (messages >= 0),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS global_daily_usage;

    ALTER TABLE system_settings
      DROP CONSTRAINT IF EXISTS system_settings_max_messages_per_day_global_check,
      DROP COLUMN IF EXISTS max_messages_per_day_global;
  `);
};
