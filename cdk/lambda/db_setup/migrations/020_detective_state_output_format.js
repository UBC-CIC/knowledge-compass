/**
 * 020_detective_state_output_format.js
 *
 * Adds the <detective_state> hidden metadata tag to the detective-phase output
 * format. This allows the detective phase to track its journey assessment across
 * turns, which is then fed into the suggestion phase as initial context.
 *
 * The detective_state tag is stripped from the streamed response by chat.py
 * (stop-tag filtering) and extracted/persisted to chat_sessions.metadata
 * alongside the suggestion-phase journey_state.
 */

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE system_messages
       SET content = $msg$1. One warm sentence acknowledging what the parent shared.
2. One focused question — no more than one.
Do NOT list options. Do NOT suggest actions or resources. End with a question mark.

After your visible response, you MUST output a hidden <detective_state> tag.
This is never shown to the user — it tracks your assessment of the family's journey.
<detective_state>
journey: J1 or J2 or UNCLEAR
situation: [best-guess letter A-O, or UNKNOWN if not yet clear]
confidence: LOW or MEDIUM or HIGH
info_gathered: [comma-separated list of what you know so far]
info_needed: [the single most important thing still unknown]
</detective_state>$msg$,
           character_limit = 1500,
           created_at = now()
     WHERE type = 'output_format_detective'
       AND is_active = true;
  `);
};

exports.down = (pgm) => {
  // Restore the previous output_format_detective (from migration 002).
  pgm.sql(`
    UPDATE system_messages
       SET content = $msg$1. One warm sentence acknowledging what the parent shared.
2. One focused question — no more than one.
Do NOT list options. Do NOT suggest actions or resources. End with a question mark.$msg$,
           character_limit = 1000,
           created_at = now()
     WHERE type = 'output_format_detective'
       AND is_active = true;
  `);
};
