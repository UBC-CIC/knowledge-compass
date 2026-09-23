/**
 * 010_drop_ubc_system_messages.js
 *
 * Removes the remaining UBC Specialization Explorer system_messages rows so the
 * Admin "Assistant settings" page only lists Knowledge Compass content.
 *
 * Migration 002 deactivated the UBC rows but left them in place. The admin page
 * falls back to the newest row when no version is active, so these rows still
 * showed up as editable UBC prompts.
 *
 * Changes:
 *   1. Deletes every row of the UBC-only types (initial_prompt, system_checklist,
 *      system_instructions). The text generation pipeline (helpers/logic.py)
 *      never reads them.
 *   2. Deletes the inactive UBC version-1 seeds (created_by NULL) of the types
 *      that were reused for Knowledge Compass. Admin-created versions are kept.
 *   3. Seeds an active disclaimer, matching the frontend fallback text, when no
 *      active disclaimer exists.
 *
 * Enum values are left in place (Postgres cannot drop them without recreating
 * the type); adminHandler.js no longer allow-lists the UBC-only types.
 */

exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM system_messages
    WHERE type IN ('initial_prompt', 'system_checklist', 'system_instructions');

    DELETE FROM system_messages
    WHERE type IN (
        'disclaimer',
        'guardrails',
        'system_role',
        'detective_phase_prompt',
        'suggestion_phase_prompt',
        'welcome_message'
      )
      AND version = 1
      AND created_by IS NULL
      AND is_active = false;

    INSERT INTO system_messages (type, content, character_limit, version, is_active, affects_text_generation, created_by, created_at)
    SELECT
      'disclaimer',
      $msg$Knowledge Compass shares information from Inclusion Canada's reviewed guidance. It isn't legal advice, and it can make mistakes.$msg$,
      700,
      COALESCE((SELECT MAX(version) FROM system_messages WHERE type = 'disclaimer'), 0) + 1,
      TRUE, FALSE, NULL, now()
    WHERE NOT EXISTS (
      SELECT 1 FROM system_messages WHERE type = 'disclaimer' AND is_active = true
    );
  `);
};

exports.down = () => {
  // The deleted rows were UBC content with no use in Knowledge Compass; they
  // remain available in migration 000 and git history. Nothing is restored.
};
