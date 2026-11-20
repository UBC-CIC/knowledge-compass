/**
 * 043_journey_document_prompts.js
 *
 * "How it talks" follows an uploaded guide section when one is retrieved,
 * and still asks from a journey's own questions when no document covers it.
 *
 * Each prompt is replaced only while its active text is still the migration
 * 027 text, so an admin edit is never overwritten. Previous versions stay,
 * so the Prompts page can go back.
 *
 * Keep the text below in sync with helpers/config.py (tests/test_prompt_sync.py).
 */

const { seed: seed027 } = require("./027_plain_conversation_prompts");

const DETECTIVE_OLD = seed027.detective;
const SUGGESTION_OLD = seed027.suggestion;

const DETECTIVE = `Ask exactly ONE warm, focused question. Acknowledge what the parent said first.

STEP 1 — IDENTIFY THE JOURNEY using the signals listed for each journey below.

Rights/concept signals (can appear in any journey):
  "rights," "Article 24," "undue hardship," "duty to accommodate,"
  "personal care," "medication," "appeal," "lawyer," "legal,"
  "inclusive education," "what is PDA"

STEP 2 — UNDERSTAND WHERE THEY ARE. Ask until the situation is clear. When a
journey lists situations from its uploaded guides, ask the one question that
best tells those situations apart. When a journey still lists its own questions,
ask those in order. If the journey is not clear yet, ask the question that best
tells the journeys apart.

STRICT RULES:
- ONE question only per turn. Never list multiple questions.
- Do NOT suggest resources, next steps, or actions on this turn. The system moves to
  guidance automatically once the family's situation is clear.
- Never assume gender, disability type, or province without the parent mentioning it.
- Never assume the family requested the reduced schedule.`;

const SUGGESTION = `When this turn includes an uploaded guide section, follow that one section.
Use its steps, order and wording. Do not add steps that are not in that section
or in a supporting library source you cite. If the section says to ask something
first, ask that. Cite the section and every library source you used.

${SUGGESTION_OLD}`;

const CHARACTER_LIMITS = { detective_phase_prompt: 4000, suggestion_phase_prompt: 25000 };

const lit = (text, tag) => {
  if (text.includes(`$${tag}$`)) throw new Error(`text contains $${tag}$`);
  return `$${tag}$${text}$${tag}$`;
};

const lf = (expr) => `replace(${expr}, E'\\r\\n', E'\\n')`;

const replaceIfShipped = (type, expected, content) => `
  DO $do$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM system_messages
       WHERE type = '${type}' AND is_active = true
         AND ${lf("content")} = ${lit(expected, "old")}
    ) THEN
      UPDATE system_messages SET is_active = false
       WHERE type = '${type}' AND is_active = true;

      INSERT INTO system_messages
        (type, content, character_limit, version, is_active, affects_text_generation, created_by, created_at)
      SELECT '${type}', ${lit(content, "new")}, GREATEST(${CHARACTER_LIMITS[type]}, MAX(character_limit)),
             COALESCE(MAX(version), 0) + 1, true, true, NULL, now()
        FROM system_messages
       WHERE type = '${type}';
    ELSE
      RAISE NOTICE '043_journey_document_prompts: % skipped (active text was edited)', '${type}';
    END IF;
  END
  $do$;
`;

const removeIfAdded = (type, content) => `
  DELETE FROM system_messages
   WHERE type = '${type}' AND created_by IS NULL
     AND ${lf("content")} = ${lit(content, "new")};

  UPDATE system_messages SET is_active = true
   WHERE id = (
     SELECT id FROM system_messages WHERE type = '${type}'
      ORDER BY version DESC, created_at DESC LIMIT 1
   )
     AND NOT EXISTS (SELECT 1 FROM system_messages WHERE type = '${type}' AND is_active = true);
`;

exports.up = (pgm) => {
  pgm.sql(replaceIfShipped("detective_phase_prompt", DETECTIVE_OLD, DETECTIVE));
  pgm.sql(replaceIfShipped("suggestion_phase_prompt", SUGGESTION_OLD, SUGGESTION));
};

exports.down = (pgm) => {
  pgm.sql(removeIfAdded("suggestion_phase_prompt", SUGGESTION));
  pgm.sql(removeIfAdded("detective_phase_prompt", DETECTIVE));
};

exports.seed = {
  detective: DETECTIVE,
  suggestion: SUGGESTION,
  detectiveOld: DETECTIVE_OLD,
  suggestionOld: SUGGESTION_OLD,
  characterLimits: CHARACTER_LIMITS,
};
