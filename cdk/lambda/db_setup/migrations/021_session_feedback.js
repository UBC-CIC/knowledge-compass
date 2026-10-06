/**
 * 021_session_feedback.js
 *
 * End-of-conversation feedback from public users: a thumbs up / thumbs down
 * rating plus an optional free-text comment. One row per chat session; the
 * user can change their rating or comment, which updates the same row.
 * Rows cascade with their chat session so deleting a conversation also
 * removes its feedback.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS session_feedback (
      id               uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
      chat_session_id  uuid          NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      rating           varchar(8)    NOT NULL CHECK (rating IN ('up', 'down')),
      comment          text          CHECK (comment IS NULL OR char_length(comment) <= 1000),
      created_at       timestamptz   NOT NULL DEFAULT now(),
      updated_at       timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT uq_session_feedback_session UNIQUE (chat_session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_session_feedback_updated_at ON session_feedback(updated_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS session_feedback;
  `);
};
