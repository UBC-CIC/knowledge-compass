/**
 * 007_drop_hallucination_warning_messages.js
 *
 * The `partial_hallucination_warning` and `full_hallucination_warning`
 * system_messages rows are UBC-domain leftovers from migration 000 (their
 * seeded content references "the knowledge base powering the AI-driven BSc
 * Specialization Explorer"). They are not fetched by the public
 * systemMessagesHandler and are not used by the chat generation pipeline
 * (chat.py/intervention.py produce their own hardcoded grounding warnings),
 * so they only ever showed up as dead editable entries in the Admin
 * System Settings page.
 *
 * This migration deletes the existing rows. It intentionally leaves the
 * `system_message_type` enum values in place, since Postgres enum values
 * cannot be dropped without recreating the type, and no code path writes
 * these types anymore (adminHandler.js no longer allow-lists them).
 */

exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM system_messages
    WHERE type IN ('partial_hallucination_warning', 'full_hallucination_warning');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    INSERT INTO system_messages (type, content, character_limit, version, is_active, affects_text_generation, created_by, created_at)
    VALUES
      (
        'partial_hallucination_warning',
        'Warning: The knowledge base powering the AI-driven BSc Specialization Explorer contains information from within and outside of UBC-governed sources. Given the nature of the Explorer''s LLM, parts of this answer may not be fully supported by the UBC source content and could contain inaccurate program or course details. Please verify against the relevant UBC calendar page.',
        700,
        1, TRUE, FALSE, NULL, now()
      ),
      (
        'full_hallucination_warning',
        'Warning: The knowledge base powering the AI-driven BSc Specialization Explorer contains information from within and outside of UBC-governed sources. Given the nature of the Explorer''s LLM, this answer may not be reliably grounded in the UBC source content and could contain incorrect program or course information. Please verify against the relevant UBC calendar page.',
        700,
        1, TRUE, FALSE, NULL, now()
      )
    ON CONFLICT (type, version) DO NOTHING;
  `);
};
