/**
 * 026_drop_cluster_priority.js
 *
 * Removes situation priority. Admins no longer rank situations; when two
 * situations fit, the model decides which need to address first from the
 * conversation.
 *
 * Changes:
 *   1. Drops journey_clusters.priority and its range constraint (migration 024).
 *   2. Edits the active suggestion_phase_prompt so it no longer points at the
 *      "priority order" list that helpers/journeys.py used to render. Only the
 *      listed passage is replaced, and only if present (NOTICE otherwise).
 *
 * down re-adds the column and restores the values seeded by 024 for the
 * seeded keys (others get 5), then reverts the prompt passage.
 *
 * Keep the passage in sync with helpers/config.py (tests/test_prompt_sync.py).
 */

const { seed: seed024 } = require("./024_journey_cluster_prompts");

const SUGGESTION_ORDER_OLD = `If the conversation spans multiple situations, address the most pressing need
first and note the other briefly as a follow-up, using the priority order in the
<journeys> block.`;

const SUGGESTION_ORDER_NEW = `If the conversation spans multiple situations, address the most pressing need
first and note the other briefly as a follow-up.`;

const lit = (text, tag) => {
  if (text.includes(`$${tag}$`)) throw new Error(`text contains $${tag}$`);
  return `$${tag}$${text}$${tag}$`;
};

// Normalise CRLF -> LF for a SQL expression.
const lf = (expr) => `replace(${expr}, E'\\r\\n', E'\\n')`;

const editSuggestion = (label, oldText, newText) => `
  DO $do$
  BEGIN
    UPDATE system_messages
       SET content = replace(${lf("content")}, ${lf(lit(oldText, "old"))}, ${lf(lit(newText, "new"))}),
           created_at = now()
     WHERE type = 'suggestion_phase_prompt'
       AND is_active = true
       AND strpos(${lf("content")}, ${lf(lit(oldText, "old"))}) > 0;
    IF NOT FOUND THEN
      RAISE NOTICE '026_drop_cluster_priority: % not applied (passage not found in active suggestion_phase_prompt)', '${label}';
    END IF;
  END
  $do$;
`;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE journey_clusters
      DROP CONSTRAINT IF EXISTS journey_clusters_priority_range,
      DROP COLUMN IF EXISTS priority;
  `);
  pgm.sql(editSuggestion("suggestion order", SUGGESTION_ORDER_OLD, SUGGESTION_ORDER_NEW));
};

exports.down = (pgm) => {
  pgm.sql(editSuggestion("revert suggestion order", SUGGESTION_ORDER_NEW, SUGGESTION_ORDER_OLD));

  const restore = seed024.clusters
    .map((c) => `UPDATE journey_clusters SET priority = ${Number(c.priority)} WHERE key = '${c.key}';`)
    .join("\n");
  pgm.sql(`
    ALTER TABLE journey_clusters ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 5;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journey_clusters_priority_range') THEN
        ALTER TABLE journey_clusters
          ADD CONSTRAINT journey_clusters_priority_range CHECK (priority BETWEEN 1 AND 9);
      END IF;
    END $$;
    ${restore}
  `);
};

// Exposed for tests/test_prompt_sync.py (node-pg-migrate only uses up/down).
exports.seed = { suggestionEdit: [SUGGESTION_ORDER_OLD, SUGGESTION_ORDER_NEW] };
