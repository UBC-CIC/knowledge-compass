/**
 * 047_daily_session_limit.js
 *
 * Per-user cap on new chat sessions per UTC day (finding F19 / M7, decision
 * D12: 20 per day). POST /chat_sessions (handlers/chatSessionHandler.js)
 * claims a slot with an atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE
 * sessions_created < limit in the same transaction as the session insert.
 *
 * Creations are counted, not existing rows: DELETE /chat_sessions/{id} does
 * not free a slot, so create/delete loops cannot get around the cap.
 *
 * Changes:
 *   1. user_daily_usage (migration 034, one row per user and UTC date) gains
 *      sessions_created integer NOT NULL DEFAULT 0, CHECK >= 0. Existing rows
 *      read as 0. The character counter is unaffected.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_daily_usage
      ADD COLUMN IF NOT EXISTS sessions_created integer NOT NULL DEFAULT 0;

    DO $$ BEGIN
      ALTER TABLE user_daily_usage
        ADD CONSTRAINT user_daily_usage_sessions_created_check CHECK (sessions_created >= 0);
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_daily_usage
      DROP CONSTRAINT IF EXISTS user_daily_usage_sessions_created_check,
      DROP COLUMN IF EXISTS sessions_created;
  `);
};
