/**
 * 030_feedback_message.js
 *
 * Links session feedback to the assistant reply that was rated. The public
 * feedback widget sits under the latest finished reply, so when feedback is
 * saved the server records that session's latest assistant message
 * (chatSessionHandler.js). Each later edit moves the link to the reply the
 * widget is under at that time.
 *
 * Existing rows stay NULL; the admin review endpoint falls back to the last
 * assistant reply saved before the feedback (utils/feedbackTriage.js).
 * ON DELETE SET NULL keeps the feedback if a message is ever removed.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE session_feedback
      ADD COLUMN IF NOT EXISTS chat_message_id uuid
        REFERENCES chat_messages(id) ON DELETE SET NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE session_feedback
      DROP COLUMN IF EXISTS chat_message_id;
  `);
};
