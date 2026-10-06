/**
 * 022_dynamic_routing.js
 *
 * Per-turn dynamic routing (textGeneration/helpers/routing.py).
 *
 * Changes:
 *   1. system_settings gains:
 *        - routing_mode                 'fixed' (default, today's exchange-count rule)
 *                                       or 'dynamic' (per-turn router decides)
 *        - min_exchanges_before_answer  floor for dynamic mode (default 0: a clear
 *                                       first message can be answered immediately)
 *      min_messages_before_suggest keeps its meaning in fixed mode and becomes the
 *      ceiling ("give guidance by this exchange at the latest") in dynamic mode.
 *   2. New system_message_type 'output_format_partial' with an active v1 row: the
 *      combined answer-and-ask format used for MEDIUM-confidence turns.
 *   3. Targeted edits to the active detective/suggestion prompts. Only the listed
 *      passages are replaced (SQL replace()); the rest of each prompt is untouched:
 *        - detective: status line no longer says "of at least N"; the EARLY CLARITY
 *          RULE and the {may_suggest} rules are removed (routing decides now) and a
 *          rule to use the <focus> block is added.
 *        - suggestion: opening paragraph gains the <routing_hint> reference and a
 *          priority order for multi-cluster turns.
 *      Each edit only applies when the original passage is present, and raises a
 *      NOTICE otherwise. Line endings are normalised to LF before matching.
 *
 * Keep the text below in sync with helpers/config.py (fallback defaults).
 * tests/test_prompt_sync.py checks that migration 018 + these edits == config.py.
 *
 * Runs outside a transaction because ALTER TYPE ... ADD VALUE must commit before
 * the new enum value can be used (same pattern as migration 002).
 */

const DETECTIVE_STATUS_OLD = `CURRENT STATUS: Exchange {exchange_count} of at least {min_exchanges}.
{readiness_note}`;

const DETECTIVE_STATUS_NEW = `CURRENT STATUS: Exchange {exchange_count}.
{readiness_note}`;

const DETECTIVE_EARLY_CLARITY_OLD = `EARLY CLARITY RULE:
If the parent's first message clearly describes a specific situation with enough
detail to provide guidance (e.g., "The school just called and told me to pick up
my child — what should I do?"), you MAY acknowledge and provide immediate guidance
even if {may_suggest} is False, but ONLY when the situation and need are unambiguous.
Otherwise, follow the exchange rules strictly.

STRICT RULES:`;

// Anchored on the following heading so the down migration can restore it.
const DETECTIVE_EARLY_CLARITY_NEW = `STRICT RULES:`;

const DETECTIVE_RULES_OLD = `- Do NOT suggest resources, next steps, or actions yet — unless {may_suggest} is True.
- If {may_suggest} is True AND the situation is already clear, you MAY provide guidance.`;

const DETECTIVE_RULES_NEW = `- Do NOT suggest resources, next steps, or actions on this turn. The system moves to
  guidance automatically once the family's situation is clear.
- If a <focus> block is provided, aim your question at that missing information.`;

const SUGGESTION_INTRO_OLD = `Review the full conversation history. Identify which situation cluster best fits,
then follow the matching response pattern. If the conversation spans multiple
clusters, address the most pressing need first and note the other as a follow-up.`;

const SUGGESTION_INTRO_NEW = `Review the full conversation history. Identify which situation cluster best fits,
then follow the matching response pattern. A <routing_hint> block may suggest a
primary and secondary cluster; treat it as a hint, the conversation is authoritative.

If the conversation spans multiple clusters, address the most pressing need first
and note the other briefly as a follow-up. Priority order:
  1. Urgent, happening now (C)
  2. Unresolved school action: no response, denial, pushback, escalation (G, H)
  3. Documentation, meetings, support plan implementation (D, E, F)
  4. Understanding the situation, the school's reason, rights and concepts (A, B, I)
  5. Support networks and future planning (J, K, L, M, N, O)`;

const OUTPUT_FORMAT_PARTIAL = `This is a PARTIAL guidance turn: the family's situation is mostly clear, but one
important detail is still missing. Give a short, useful start and ask for that detail.

You MUST wrap your response inside <answer> tags.
After your answer, you MUST list the integer indices of the sources you actively used
inside <cited_indices> tags as a JSON array (e.g. <cited_indices>[1, 3]</cited_indices>).
If no sources were used, output <cited_indices>[]</cited_indices>.

After cited_indices, you MUST output a <journey_state> block — a brief structured
summary of where this family is in their journey. Keep it concise (3-5 lines).
Format:
<journey_state>
journey: J1 or J2
situation: [letter A-O from the situation clusters]
stage: [brief description of where the family is right now]
actions_taken: [comma-separated list of what the family has already done]
next_need: [the single most likely next thing the family will need help with]
</journey_state>

Within your <answer> (keep it short, about 80-150 words):
- One or two sentences acknowledging what the family shared and naming the situation
  in plain language.
- 1-2 low-risk first steps that help whatever the missing detail turns out to be
  (for example, keeping dated notes of each early pickup, or asking the school to share
  its reasons in writing). Use bold action titles; add short italic sample wording only
  where it helps.
- Do NOT give the full plan, escalation options, or anything that depends on the
  missing detail.
- When a retrieved source directly supports a step, include a markdown link: [Title](URL).
- End with exactly ONE clarifying question in bold, aimed at the missing detail
  (see the <focus> block if provided).
- Do NOT add a separate "Sources" heading — the system lists sources below the answer.

Example format:
<answer>
It sounds like your child is being sent home before the end of the school day, which is often called partial day attendance. Many families go through this, and there are good first steps you can take right away.

**Keep a simple record.** Note the date, the time you were called, and the reason given each time.

**Ask for the reason in writing.** *"Could you share the reasons for today's early pickup in writing?"*

**Has the school said how long they expect this to continue?**
</answer>
<cited_indices>[]</cited_indices>
<journey_state>
journey: J1
situation: A
stage: Child is being sent home early; duration and school's reasons not yet known
actions_taken: described the situation
next_need: understand the school's reason and expected duration
</journey_state>`;

// Normalise CRLF -> LF for a SQL expression.
const lf = (expr) => `replace(${expr}, E'\\r\\n', E'\\n')`;

/**
 * Replace one passage in the active prompt of `type`, only if it is present.
 * Dollar-quoted literals avoid escaping; tags are unique so prompt text
 * cannot terminate them.
 */
const editActivePrompt = (label, type, oldText, newText, extraSet = "") => `
  DO $do$
  BEGIN
    UPDATE system_messages
       SET content = replace(${lf("content")}, ${lf(`$old$${oldText}$old$`)}, ${lf(`$new$${newText}$new$`)}),
           ${extraSet}
           created_at = now()
     WHERE type = '${type}'
       AND is_active = true
       AND strpos(${lf("content")}, ${lf(`$old$${oldText}$old$`)}) > 0;
    IF NOT FOUND THEN
      RAISE NOTICE '022_dynamic_routing: % not applied (passage not found in active %)', '${label}', '${type}';
    END IF;
  END
  $do$;
`;

const PROMPT_EDITS = [
  ["detective status line", "detective_phase_prompt", DETECTIVE_STATUS_OLD, DETECTIVE_STATUS_NEW],
  ["detective early clarity rule", "detective_phase_prompt", DETECTIVE_EARLY_CLARITY_OLD, DETECTIVE_EARLY_CLARITY_NEW],
  ["detective may_suggest rules", "detective_phase_prompt", DETECTIVE_RULES_OLD, DETECTIVE_RULES_NEW],
  [
    "suggestion intro",
    "suggestion_phase_prompt",
    SUGGESTION_INTRO_OLD,
    SUGGESTION_INTRO_NEW,
    // The 018 content (~23k chars) already exceeds its 16000 limit, which blocks
    // admin edits; raise it with room for small additions.
    "character_limit = GREATEST(character_limit, 25000),",
  ],
];

exports.up = (pgm) => {
  pgm.noTransaction();

  // 1. Enum value (idempotent). Must commit before it is used below.
  pgm.sql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                     WHERE t.typname = 'system_message_type' AND e.enumlabel = 'output_format_partial') THEN
        ALTER TYPE system_message_type ADD VALUE 'output_format_partial';
      END IF;
    END $$;
  `);

  // 2. Routing settings. ADD COLUMN ... DEFAULT backfills existing rows.
  pgm.sql(`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS routing_mode varchar(16) NOT NULL DEFAULT 'fixed',
      ADD COLUMN IF NOT EXISTS min_exchanges_before_answer int NOT NULL DEFAULT 0;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_routing_mode_check') THEN
        ALTER TABLE system_settings
          ADD CONSTRAINT system_settings_routing_mode_check CHECK (routing_mode IN ('fixed', 'dynamic'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_min_exchanges_before_answer_check') THEN
        ALTER TABLE system_settings
          ADD CONSTRAINT system_settings_min_exchanges_before_answer_check CHECK (min_exchanges_before_answer >= 0);
      END IF;
    END $$;
  `);

  // 3. Seed the partial output format (skip if a row already exists).
  pgm.sql(`
    INSERT INTO system_messages (type, content, character_limit, version, is_active, affects_text_generation, created_by, created_at)
    SELECT 'output_format_partial', $partial$${OUTPUT_FORMAT_PARTIAL}$partial$, 3500, 1, TRUE, TRUE, NULL, now()
     WHERE NOT EXISTS (SELECT 1 FROM system_messages WHERE type = 'output_format_partial');
  `);

  // 4. Targeted prompt edits.
  for (const [label, type, oldText, newText, extraSet] of PROMPT_EDITS) {
    pgm.sql(editActivePrompt(label, type, oldText, newText, extraSet));
  }
};

exports.down = (pgm) => {
  pgm.noTransaction();

  // Reverse the prompt edits (new -> old), last edit first.
  for (const [label, type, oldText, newText] of [...PROMPT_EDITS].reverse()) {
    pgm.sql(editActivePrompt(`revert ${label}`, type, newText, oldText));
  }

  // The enum value cannot be dropped in PostgreSQL; remove its rows only.
  pgm.sql(`
    DELETE FROM system_messages WHERE type = 'output_format_partial';

    ALTER TABLE system_settings
      DROP CONSTRAINT IF EXISTS system_settings_min_exchanges_before_answer_check,
      DROP CONSTRAINT IF EXISTS system_settings_routing_mode_check,
      DROP COLUMN IF EXISTS min_exchanges_before_answer,
      DROP COLUMN IF EXISTS routing_mode;
  `);
};
