/**
 * 035_eval_sessions.js
 *
 * Server-only columns for evaluation-harness sessions (evals/).
 *
 * Changes:
 *   1. chat_sessions.eval_run_id: the harness run that created the session.
 *      Set only by POST /chat_sessions after an HMAC-signed eval tag is verified
 *      (handlers/utils/evalTag.js); never from client metadata. Admin analytics
 *      and journey feedback counts exclude rows where it is set.
 *   2. chat_sessions.prompt_mode_override: per-session prompt mode for the
 *      harness's standard vs guideline comparison. NULL = use the global
 *      guideline_config.prompt_mode. Read by textGeneration through
 *      config.resolve_prompt_mode, the single point a future dual mode replaces.
 *   3. Partial index on eval_run_id for cleanup and filtering.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE chat_sessions
      ADD COLUMN IF NOT EXISTS eval_run_id varchar(64) NULL,
      ADD COLUMN IF NOT EXISTS prompt_mode_override varchar(16) NULL;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_sessions_prompt_mode_override_check') THEN
        ALTER TABLE chat_sessions
          ADD CONSTRAINT chat_sessions_prompt_mode_override_check
          CHECK (prompt_mode_override IS NULL OR prompt_mode_override IN ('standard', 'guideline'));
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS chat_sessions_eval_run_id_idx
      ON chat_sessions (eval_run_id)
      WHERE eval_run_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS chat_sessions_eval_run_id_idx;

    ALTER TABLE chat_sessions
      DROP CONSTRAINT IF EXISTS chat_sessions_prompt_mode_override_check,
      DROP COLUMN IF EXISTS prompt_mode_override,
      DROP COLUMN IF EXISTS eval_run_id;
  `);
};
