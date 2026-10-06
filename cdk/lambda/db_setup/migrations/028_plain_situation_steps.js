/**
 * 028_plain_situation_steps.js
 *
 * Formatting-only cleanup of the seeded situation steps (response_pattern
 * versions from migration 024), so they read as plain instructions on the
 * admin Prompts page:
 *   - the leading "Response pattern:" line is removed (sub-headings such as
 *     "Response pattern for denial:" are kept),
 *   - hard-wrapped lines are joined onto the item or paragraph they belong to,
 *   - blank lines between paragraphs are kept.
 * No words change (tests/test_prompt_sync.py and the node tests check this).
 *
 * A new active version is added only for situations whose active steps are
 * still the 024 seed text, so admin edits are never overwritten. The previous
 * version is kept, so admins can go back from the Prompts page.
 *
 * Keep helpers/journeys.py DEFAULT_CATALOG in sync (tests/test_prompt_sync.py).
 */

const { seed: seed024 } = require("./024_journey_cluster_prompts");

const ITEM = /^(\d+\.|[-*•])\s/;

/** Pure formatting cleanup; idempotent. */
function cleanSteps(text) {
  let lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[0].trim() === "Response pattern:") lines = lines.slice(1);
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (!t) {
      out.push("");
      continue;
    }
    const prev = out.length ? out[out.length - 1] : "";
    const indented = /^\s/.test(line);
    // A wrapped line continues the previous one unless it starts a new item,
    // or (when not indented) the previous line is a heading ending in ":".
    const continues = prev !== "" && !ITEM.test(t) && (indented || !prev.endsWith(":"));
    if (continues) out[out.length - 1] = `${prev} ${t}`;
    else out.push(t);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const lit = (text, tag) => {
  if (text.includes(`$${tag}$`)) throw new Error(`text contains $${tag}$`);
  return `$${tag}$${text}$${tag}$`;
};

// Normalise CRLF -> LF for a SQL expression.
const lf = (expr) => `replace(${expr}, E'\\r\\n', E'\\n')`;

const cleanCluster = (c) => `
  DO $do$
  DECLARE cid uuid;
  BEGIN
    SELECT v.cluster_id INTO cid
      FROM journey_prompt_versions v
      JOIN journey_clusters jc ON jc.id = v.cluster_id
     WHERE jc.key = '${c.key}' AND v.field = 'response_pattern' AND v.is_active
       AND ${lf("v.content")} = ${lit(c.responsePattern, "old")};
    IF cid IS NULL THEN
      RAISE NOTICE '028_plain_situation_steps: % skipped (steps were edited or missing)', '${c.key}';
      RETURN;
    END IF;

    UPDATE journey_prompt_versions SET is_active = false
     WHERE cluster_id = cid AND field = 'response_pattern' AND is_active;

    INSERT INTO journey_prompt_versions
      (field, cluster_id, content, character_limit, version, is_active, created_by, created_at)
    SELECT 'response_pattern', cid, ${lit(cleanSteps(c.responsePattern), "new")},
           MAX(character_limit), MAX(version) + 1, true, NULL, now()
      FROM journey_prompt_versions
     WHERE cluster_id = cid AND field = 'response_pattern';
  END
  $do$;
`;

const restoreCluster = (c) => `
  DO $do$
  DECLARE cid uuid;
  BEGIN
    SELECT id INTO cid FROM journey_clusters WHERE key = '${c.key}';
    IF cid IS NULL THEN RETURN; END IF;

    DELETE FROM journey_prompt_versions
     WHERE cluster_id = cid AND field = 'response_pattern' AND created_by IS NULL
       AND ${lf("content")} = ${lit(cleanSteps(c.responsePattern), "new")};

    UPDATE journey_prompt_versions SET is_active = true
     WHERE id = (
       SELECT id FROM journey_prompt_versions
        WHERE cluster_id = cid AND field = 'response_pattern'
        ORDER BY version DESC, created_at DESC LIMIT 1
     )
       AND NOT EXISTS (
         SELECT 1 FROM journey_prompt_versions
          WHERE cluster_id = cid AND field = 'response_pattern' AND is_active
       );
  END
  $do$;
`;

exports.up = (pgm) => {
  for (const c of seed024.clusters) pgm.sql(cleanCluster(c));
};

exports.down = (pgm) => {
  for (const c of seed024.clusters) pgm.sql(restoreCluster(c));
};

// Exposed for tests (node-pg-migrate only uses up/down).
exports.cleanSteps = cleanSteps;
exports.seed = {
  steps: Object.fromEntries(seed024.clusters.map((c) => [c.key, cleanSteps(c.responsePattern)])),
};
