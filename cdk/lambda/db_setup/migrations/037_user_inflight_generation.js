/**
 * 037_user_inflight_generation.js
 *
 * One in-flight generation per user
 * (textGeneration/helpers/message_limits.py: claim_generation_slot /
 * release_generation_slot). Without it, one identity can fire many parallel
 * WebSocket frames and run many Bedrock generations at the same time.
 *
 * Changes:
 *   1. New table user_inflight_generations: at most one row per user, holding
 *      only the Lambda request id that owns the slot and when it started (no
 *      message text). The slot is claimed with an atomic
 *      INSERT ... ON CONFLICT (user_id) DO UPDATE ... WHERE, which takes over
 *      the row only when it is stale (older than the 90 second window, above
 *      the 60 second Lambda timeout) or already owned by the same request id.
 *      It is released with DELETE ... WHERE user_id AND request_id when the
 *      generation ends.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS user_inflight_generations (
      user_id     uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      request_id  text        NOT NULL,
      started_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS user_inflight_generations;
  `);
};
