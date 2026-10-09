/**
 * 032_general_welcome_message.js
 *
 * Makes the public welcome message more general so the conversation is led
 * by the user, and avoids wording that makes the assistant sound like a person
 * ("Tell me what's been happening").
 *
 * Adds a new active version only when the active welcome_message is still the
 * unedited seed from 002, so admin customisations are left alone. The previous
 * version is kept, so admins can undo from the Prompts page.
 *
 * Keep NEW_WELCOME in sync with frontend/src/components/Admin/defaultSystemMessages.ts
 * and the heading/ask constants in frontend/src/pages/ChatInterface/ChatInterface.tsx.
 */

const OLD_WELCOME = `Hi, I'm here to help you navigate your child's education.

Whether your child is being sent home early or excluded from school activities, or you're planning for their future — you don't have to figure this out alone.

Tell me what's been happening. What's going on with your child's schooling right now?`;

const NEW_WELCOME = `Hello, I'm here to help you navigate support that is available to you from Inclusion Canada.

Whether your child is being sent home early or excluded from school activities, or you're planning for their future — you don't have to figure this out alone.

Type in information about what's happening. Is there something happening with your child's schooling right now?`;

const CHARACTER_LIMIT = 2000;

const lit = (text, tag = "msg") => {
  if (text.includes(`$${tag}$`)) throw new Error(`text contains $${tag}$`);
  return `$${tag}$${text}$${tag}$`;
};

// Normalise CRLF -> LF for a SQL expression.
const lf = (expr) => `replace(${expr}, E'\\r\\n', E'\\n')`;

exports.up = (pgm) => {
  pgm.sql(`
    DO $do$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM system_messages
         WHERE type = 'welcome_message' AND is_active = true
           AND ${lf("content")} = ${lit(OLD_WELCOME, "old")}
      ) THEN
        UPDATE system_messages SET is_active = false
         WHERE type = 'welcome_message' AND is_active = true;

        INSERT INTO system_messages
          (type, content, character_limit, version, is_active, affects_text_generation, created_by, created_at)
        SELECT 'welcome_message', ${lit(NEW_WELCOME)}, ${CHARACTER_LIMIT},
               COALESCE(MAX(version), 0) + 1, true, false, NULL, now()
          FROM system_messages
         WHERE type = 'welcome_message';
      END IF;
    END
    $do$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM system_messages
     WHERE type = 'welcome_message' AND created_by IS NULL
       AND ${lf("content")} = ${lit(NEW_WELCOME)};

    UPDATE system_messages SET is_active = true
     WHERE id = (
       SELECT id FROM system_messages WHERE type = 'welcome_message'
        ORDER BY version DESC, created_at DESC LIMIT 1
     )
       AND NOT EXISTS (SELECT 1 FROM system_messages WHERE type = 'welcome_message' AND is_active = true);
  `);
};
