/**
 * 034_daily_character_limit.js
 *
 * Per-user daily character limit on the message text a user sends
 * (textGeneration/helpers/message_limits.py: reserve_daily_characters).
 *
 * Changes:
 *   1. system_settings gains max_characters_per_day (default 10000), the number
 *      of characters one user can send per UTC calendar day across all of their
 *      chat sessions. Admin-editable through /admin/system-settings.
 *   2. New table user_daily_usage: one row per (user, UTC date) holding only the
 *      running character count. Message text is never stored here. The row is
 *      written with an atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE, so
 *      concurrent messages from the same user cannot both pass the limit.
 *   3. New table daily_usage_requests: one row per counted Lambda request
 *      (aws_request_id, which stays the same across async retries) holding only
 *      the reserved count (plus created_at for pruning); no user id and no
 *      message text. It is claimed with INSERT ... ON CONFLICT DO NOTHING in
 *      the same transaction as the increment, so a retried invocation does not
 *      count the message twice, and a rejected message leaves no claim behind.
 *
 * Keep the default in sync with helpers/config.py (MAX_CHARACTERS_PER_DAY) and
 * the adminHandler GET fallback.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS max_characters_per_day integer NOT NULL DEFAULT 10000;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_max_characters_per_day_check') THEN
        ALTER TABLE system_settings
          ADD CONSTRAINT system_settings_max_characters_per_day_check CHECK (max_characters_per_day > 0);
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS user_daily_usage (
      user_id          uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date       date        NOT NULL,
      characters_sent  integer     NOT NULL DEFAULT 0 CHECK (characters_sent >= 0),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, usage_date)
    );

    CREATE TABLE IF NOT EXISTS daily_usage_requests (
      request_id           text        PRIMARY KEY,
      characters_reserved  integer     NOT NULL CHECK (characters_reserved >= 0),
      created_at           timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS daily_usage_requests;
    DROP TABLE IF EXISTS user_daily_usage;

    ALTER TABLE system_settings
      DROP CONSTRAINT IF EXISTS system_settings_max_characters_per_day_check,
      DROP COLUMN IF EXISTS max_characters_per_day;
  `);
};
