/**
 * 027_plain_conversation_prompts.js
 *
 * Plain-language versions of the two "How it talks" prompts on the admin
 * Prompts page (detective_phase_prompt, suggestion_phase_prompt).
 *
 * The shipped versions contained app machinery that admins had to edit
 * around: the {exchange_count} / {readiness_note} placeholders and references
 * to the <journeys>, <focus> and <routing_hint> blocks. The app now adds those
 * itself (textGeneration/helpers/logic.py, code-owned constants in
 * helpers/config.py). Human-written rules are kept word for word; only the
 * sentences that named blocks are reworded or moved into code.
 *
 * Each prompt is only replaced if its active text is still the shipped text
 * (024 base, plus the 026 edit for suggestion), so admin edits are never
 * overwritten (a NOTICE is raised instead). Previous versions are kept, so
 * admins can go back from the Prompts page. Older versions that still contain
 * placeholders keep working (logic.py legacy path).
 *
 * Keep the text below in sync with helpers/config.py (tests/test_prompt_sync.py).
 */

const { seed: seed024 } = require("./024_journey_cluster_prompts");
const { seed: seed026 } = require("./026_drop_cluster_priority");

const DETECTIVE = `Ask exactly ONE warm, focused question. Acknowledge what the parent said first.

STEP 1 — IDENTIFY THE JOURNEY using the signals listed for each journey below.

Rights/concept signals (can appear in any journey):
  "rights," "Article 24," "undue hardship," "duty to accommodate,"
  "personal care," "medication," "appeal," "lawyer," "legal,"
  "inclusive education," "what is PDA"

STEP 2 — UNDERSTAND WHERE THEY ARE by asking the questions listed for the
family's journey (in order, if unknown). If the journey is not clear yet, ask
the question that best tells the journeys apart.

STRICT RULES:
- ONE question only per turn. Never list multiple questions.
- Do NOT suggest resources, next steps, or actions on this turn. The system moves to
  guidance automatically once the family's situation is clear.
- Never assume gender, disability type, or province without the parent mentioning it.
- Never assume the family requested the reduced schedule.`;

const [SUGGESTION_EDIT_OLD, SUGGESTION_EDIT_NEW] = seed026.suggestionEdit;

// What was live before this migration.
const DETECTIVE_OLD = seed024.detectiveBase;
const SUGGESTION_OLD = seed024.suggestionBase.replace(SUGGESTION_EDIT_OLD, SUGGESTION_EDIT_NEW);

// Drop the opening paragraph (it explained the <journeys>/<routing_hint>
// blocks); everything after it is kept verbatim.
const SUGGESTION = SUGGESTION_OLD.slice(SUGGESTION_OLD.indexOf("\n\n") + 2);

const CHARACTER_LIMITS = { detective_phase_prompt: 4000, suggestion_phase_prompt: 25000 };

const lit = (text, tag) => {
  if (text.includes(`$${tag}$`)) throw new Error(`text contains $${tag}$`);
  return `$${tag}$${text}$${tag}$`;
};

// Normalise CRLF -> LF for a SQL expression.
const lf = (expr) => `replace(${expr}, E'\\r\\n', E'\\n')`;

// Publish `content` as a new active version, only while `expected` is active.
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
      RAISE NOTICE '027_plain_conversation_prompts: % skipped (active text was edited)', '${type}';
    END IF;
  END
  $do$;
`;

// Remove the version added by `up` and re-activate the latest remaining one.
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

// Exposed for tests/test_prompt_sync.py (node-pg-migrate only uses up/down).
exports.seed = {
  detective: DETECTIVE,
  suggestion: SUGGESTION,
  detectiveOld: DETECTIVE_OLD,
  suggestionOld: SUGGESTION_OLD,
  characterLimits: CHARACTER_LIMITS,
};
