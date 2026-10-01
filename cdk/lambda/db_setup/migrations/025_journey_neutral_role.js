/**
 * 025_journey_neutral_role.js
 *
 * Removes the hard-coded JOURNEY 1 / JOURNEY 2 descriptions from system_role.
 * The list of supported journeys is now appended to the role on every turn
 * from the journeys table (textGeneration/helpers/journeys.build_journey_list),
 * so adding or renaming a journey in the admin Prompts page no longer needs a
 * matching edit here.
 *
 * Adds a new active version (the previous one is kept, so admins can undo
 * from the Prompts page). Skipped if the same text is already active.
 *
 * Keep ROLE in sync with helpers/config.py (tests/test_prompt_sync.py).
 */

const ROLE = `You are a compassionate, knowledgeable guide helping families navigate inclusive education in Canada, built for Inclusion Canada. You serve parents, support persons, and family members.

The journeys you support are listed below. Use them to understand where each family is.

Your role is to help families understand their situation, take clear next steps, and find the right resources. You do not provide legal advice or make decisions for them.`;

const CHARACTER_LIMIT = 2000;

const lit = (text, tag = "role") => {
  if (text.includes(`$${tag}$`)) throw new Error(`text contains $${tag}$`);
  return `$${tag}$${text}$${tag}$`;
};

// Normalise CRLF -> LF for a SQL expression.
const lf = (expr) => `replace(${expr}, E'\\r\\n', E'\\n')`;

exports.up = (pgm) => {
  pgm.sql(`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM system_messages
         WHERE type = 'system_role' AND is_active = true
           AND ${lf("content")} = ${lit(ROLE)}
      ) THEN
        UPDATE system_messages SET is_active = false
         WHERE type = 'system_role' AND is_active = true;

        INSERT INTO system_messages
          (type, content, character_limit, version, is_active, affects_text_generation, created_by, created_at)
        SELECT 'system_role', ${lit(ROLE)}, ${CHARACTER_LIMIT},
               COALESCE(MAX(version), 0) + 1, true, true, NULL, now()
          FROM system_messages
         WHERE type = 'system_role';
      END IF;
    END
    $do$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM system_messages
     WHERE type = 'system_role' AND created_by IS NULL
       AND ${lf("content")} = ${lit(ROLE)};

    UPDATE system_messages SET is_active = true
     WHERE id = (
       SELECT id FROM system_messages WHERE type = 'system_role'
        ORDER BY version DESC, created_at DESC LIMIT 1
     )
       AND NOT EXISTS (SELECT 1 FROM system_messages WHERE type = 'system_role' AND is_active = true);
  `);
};

// Exposed for tests/test_prompt_sync.py (node-pg-migrate only uses up/down).
exports.seed = { role: ROLE, characterLimit: CHARACTER_LIMIT };
