/**
 * 029_feedback_triage.js
 *
 * Admin triage state for end-of-conversation feedback (session_feedback,
 * migration 021). Shared by all admins:
 *   - starred_at:   set when an admin stars the feedback; NULL = not starred.
 *   - dismissed_at: set when an admin dismisses the feedback; NULL = visible.
 *     Dismissed feedback is hidden from the admin "Recent comments" list but
 *     still counts toward thumbs up/down totals. When the user edits their
 *     feedback, dismissed_at is cleared so the new text is seen again; the
 *     star is kept.
 * NULL is the default state, so no backfill is needed.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE session_feedback
      ADD COLUMN IF NOT EXISTS starred_at   timestamptz,
      ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

    CREATE INDEX IF NOT EXISTS idx_session_feedback_starred_at
      ON session_feedback(starred_at)
      WHERE starred_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_session_feedback_starred_at;

    ALTER TABLE session_feedback
      DROP COLUMN IF EXISTS dismissed_at,
      DROP COLUMN IF EXISTS starred_at;
  `);
};
