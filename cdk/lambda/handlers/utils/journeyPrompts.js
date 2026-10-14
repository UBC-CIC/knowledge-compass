/**
 * Journey and situation-cluster management for the admin API.
 *
 * Tables (migration 024):
 *   journeys                 key, name, description, detection_signals, sort_order, is_archived
 *   journey_clusters         journey_id, key, name, matches_when, sort_order, is_archived
 *                            (priority was dropped in migration 026)
 *   journey_prompt_versions  versioned prompt text, one active version per (field, owner)
 *                              detective_questions, guidance -> journey_id
 *                              response_pattern              -> cluster_id
 *
 * Metadata is edited in place; prompt text is versioned like system_messages.
 * Journeys and clusters are archived, never deleted, so session metadata and
 * feedback analytics keep pointing at a known key. Keys are immutable.
 *
 * textGeneration/helpers/journeys.py reads the same tables; keep the key rules
 * (KEY_PATTERN, RESERVED_KEYS) in sync with it.
 *
 * Privacy: feedback analytics return counts per key only, never message text
 * or comments.
 */

const { validateUUID } = require("./validation.js");

const KEY_PATTERN = /^[A-Z0-9_]{1,16}$/;
const RESERVED_KEYS = new Set(["BOTH", "UNCLEAR", "UNKNOWN", "NONE"]);

const JOURNEY_FIELDS = ["detective_questions", "guidance"];
const CLUSTER_FIELDS = ["response_pattern"];
const PROMPT_FIELDS = [...JOURNEY_FIELDS, ...CLUSTER_FIELDS];

// Default character_limit for a field's first version (mirrors migration 024).
const DEFAULT_CHARACTER_LIMITS = {
  detective_questions: 4000,
  guidance: 6000,
  response_pattern: 6000,
};

const TEXT_LIMITS = {
  name: 120,
  description: 2000,
  detection_signals: 4000,
  matches_when: 2000,
};

const MAX_SORT_ORDER = 1000;
const MAX_FEEDBACK_DAYS = 365;

class InputError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

// ------------------------------------------------------------------
// Validation (pure)
// ------------------------------------------------------------------

function validateKey(value, label = "key") {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw new InputError(
      `${label} must be 1-16 characters: upper-case letters, digits or underscore (for example J3 or P)`
    );
  }
  if (RESERVED_KEYS.has(value)) {
    throw new InputError(`${label} cannot be one of ${Array.from(RESERVED_KEYS).join(", ")}`);
  }
  return value;
}

function cleanText(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new InputError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new InputError(`${field} must be a string`);
  const text = value.replace(/\r\n/g, "\n").trim();
  if (required && !text) throw new InputError(`${field} is required`);
  const max = TEXT_LIMITS[field];
  if (max && text.length > max) throw new InputError(`${field} must be at most ${max} characters`);
  return text;
}

function cleanInt(value, field, min, max) {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new InputError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function cleanBool(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new InputError(`${field} must be true or false`);
  return value;
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Validated journey fields. `partial` (PUT) allows any subset; create requires
 * key and name. Keys can only be set on create.
 */
function validateJourneyInput(body, { partial = false } = {}) {
  if (!body || typeof body !== "object") throw new InputError("Request body is required");
  if (partial && body.key !== undefined) throw new InputError("key cannot be changed");
  const out = compact({
    key: partial ? undefined : validateKey(body.key),
    name: cleanText(body.name, "name", { required: !partial }),
    description: cleanText(body.description, "description"),
    detection_signals: cleanText(body.detection_signals, "detection_signals"),
    sort_order: cleanInt(body.sort_order, "sort_order", 0, MAX_SORT_ORDER),
    is_archived: partial ? cleanBool(body.is_archived, "is_archived") : undefined,
  });
  if (partial && Object.keys(out).length === 0) throw new InputError("No fields to update");
  if (out.name === "") throw new InputError("name cannot be empty");
  return out;
}

function validateClusterInput(body, { partial = false } = {}) {
  if (!body || typeof body !== "object") throw new InputError("Request body is required");
  if (partial && body.key !== undefined) throw new InputError("key cannot be changed");
  const out = compact({
    key: partial ? undefined : validateKey(body.key),
    name: cleanText(body.name, "name", { required: !partial }),
    matches_when: cleanText(body.matches_when, "matches_when", { required: !partial }),
    sort_order: cleanInt(body.sort_order, "sort_order", 0, MAX_SORT_ORDER),
    is_archived: partial ? cleanBool(body.is_archived, "is_archived") : undefined,
  });
  if (partial && Object.keys(out).length === 0) throw new InputError("No fields to update");
  if (out.name === "") throw new InputError("name cannot be empty");
  if (partial && out.matches_when === "") throw new InputError("matches_when cannot be empty");
  return out;
}

function validatePromptContent(body) {
  const content = typeof body?.content === "string" ? body.content.replace(/\r\n/g, "\n").trim() : "";
  if (!content) throw new InputError("content is required");
  return content;
}

function validateField(field) {
  if (!PROMPT_FIELDS.includes(field)) {
    throw new InputError(`field must be one of: ${PROMPT_FIELDS.join(", ")}`);
  }
  return field;
}

function validateId(value, label) {
  const check = validateUUID(value, label);
  if (!check.valid) throw new InputError(check.error);
  return value.trim();
}

/** "30d" | "6m" | "1y" -> days (default 30, capped at 365). "all" -> null. */
function parseFeedbackRange(value) {
  if (value === "all") return null;
  const m = String(value ?? "30d").match(/^(\d+)([dmy])$/);
  let days = 30;
  if (m) {
    const n = parseInt(m[1], 10);
    days = m[2] === "d" ? n : m[2] === "m" ? n * 30 : n * 365;
  }
  return Math.min(Math.max(1, days), MAX_FEEDBACK_DAYS);
}

// ------------------------------------------------------------------
// Shaping (pure)
// ------------------------------------------------------------------

function shapeVersion(v) {
  return {
    id: v.id,
    field: v.field,
    owner_id: v.journey_id ?? v.cluster_id,
    content: v.content,
    character_limit: v.character_limit,
    version: v.version,
    is_active: v.is_active,
    created_by_email: v.created_by_email ?? null,
    created_at: v.created_at,
  };
}

/** Nested tree: journeys -> prompts + clusters -> prompts. Input rows pre-sorted. */
function shapeTree(journeyRows, clusterRows, versionRows) {
  const byOwner = new Map();
  for (const v of versionRows) {
    const key = `${v.field}:${v.journey_id ?? v.cluster_id}`;
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(shapeVersion(v));
  }
  const prompts = (fields, id) =>
    Object.fromEntries(fields.map((f) => [f, byOwner.get(`${f}:${id}`) ?? []]));

  const clustersByJourney = new Map();
  for (const c of clusterRows) {
    if (!clustersByJourney.has(c.journey_id)) clustersByJourney.set(c.journey_id, []);
    clustersByJourney.get(c.journey_id).push({
      id: c.id,
      journey_id: c.journey_id,
      key: c.key,
      name: c.name,
      matches_when: c.matches_when,
      sort_order: c.sort_order,
      is_archived: c.is_archived,
      updated_at: c.updated_at,
      updated_by_email: c.updated_by_email ?? null,
      prompts: prompts(CLUSTER_FIELDS, c.id),
    });
  }

  return journeyRows.map((j) => ({
    id: j.id,
    key: j.key,
    name: j.name,
    description: j.description,
    detection_signals: j.detection_signals,
    sort_order: j.sort_order,
    is_archived: j.is_archived,
    updated_at: j.updated_at,
    updated_by_email: j.updated_by_email ?? null,
    prompts: prompts(JOURNEY_FIELDS, j.id),
    clusters: clustersByJourney.get(j.id) ?? [],
  }));
}

/**
 * Feedback counts per journey and cluster. `countRows` come from the
 * feedback query: { kind: 'journey'|'cluster'|'untagged', key, up, down, sessions }.
 * Every catalog item is listed (zero counts included); keys seen in sessions
 * but missing from the catalog are listed with their key as the name.
 */
function shapeFeedback(countRows, journeyRows, clusterRows, days) {
  const counts = { journey: new Map(), cluster: new Map() };
  let untagged = { up: 0, down: 0, sessions: 0 };
  for (const r of countRows) {
    const value = { up: Number(r.up) || 0, down: Number(r.down) || 0, sessions: Number(r.sessions) || 0 };
    if (r.kind === "untagged") untagged = value;
    else if (counts[r.kind]) counts[r.kind].set(r.key, value);
  }
  const zero = { up: 0, down: 0, sessions: 0 };
  const journeyKeyById = new Map(journeyRows.map((j) => [j.id, j.key]));

  const journeys = journeyRows.map((j) => ({
    key: j.key, name: j.name, is_archived: j.is_archived, ...(counts.journey.get(j.key) ?? zero),
  }));
  const clusters = clusterRows.map((c) => ({
    key: c.key, name: c.name, journey_key: journeyKeyById.get(c.journey_id) ?? null,
    is_archived: c.is_archived, ...(counts.cluster.get(c.key) ?? zero),
  }));
  const known = { journey: new Set(journeys.map((j) => j.key)), cluster: new Set(clusters.map((c) => c.key)) };
  for (const [key, value] of counts.journey) {
    if (!known.journey.has(key)) journeys.push({ key, name: key, is_archived: true, ...value });
  }
  for (const [key, value] of counts.cluster) {
    if (!known.cluster.has(key)) clusters.push({ key, name: key, journey_key: null, is_archived: true, ...value });
  }
  return { days, journeys, clusters, untagged };
}

// ------------------------------------------------------------------
// Database access
// ------------------------------------------------------------------

async function resolveAdmin(sql, event) {
  const email = event.requestContext?.authorizer?.email;
  if (!email) throw new InputError("Unauthorized", 401);
  const rows = await sql`SELECT id, role FROM users WHERE email = ${email} LIMIT 1`;
  if (rows.length === 0) throw new InputError("Admin user not found", 404);
  if (rows[0].role !== "admin") throw new InputError("User is not an admin", 403);
  return rows[0].id;
}

async function fetchTree(sql) {
  const [journeyRows, clusterRows, versionRows] = await Promise.all([
    sql`
      SELECT j.*, u.email AS updated_by_email
        FROM journeys j LEFT JOIN users u ON u.id = j.updated_by
       ORDER BY j.sort_order, j.key
    `,
    sql`
      SELECT c.*, u.email AS updated_by_email
        FROM journey_clusters c LEFT JOIN users u ON u.id = c.updated_by
       ORDER BY c.sort_order, c.key
    `,
    sql`
      SELECT v.id, v.field, v.journey_id, v.cluster_id, v.content, v.character_limit,
             v.version, v.is_active, v.created_at, u.email AS created_by_email
        FROM journey_prompt_versions v LEFT JOIN users u ON u.id = v.created_by
       ORDER BY v.is_active DESC, v.version DESC, v.created_at DESC
    `,
  ]);
  return shapeTree(journeyRows, clusterRows, versionRows);
}

const ownerColumn = (field) => (JOURNEY_FIELDS.includes(field) ? "journey_id" : "cluster_id");

async function insertVersion(tx, field, ownerId, content, adminId) {
  const column = ownerColumn(field);
  const [{ next_version }] = await tx`
    SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM journey_prompt_versions
     WHERE field = ${field} AND ${tx(column)} = ${ownerId}
  `;
  const limitRows = await tx`
    SELECT character_limit FROM journey_prompt_versions
     WHERE field = ${field} AND ${tx(column)} = ${ownerId}
     ORDER BY is_active DESC, version DESC LIMIT 1
  `;
  const characterLimit = limitRows[0]?.character_limit ?? DEFAULT_CHARACTER_LIMITS[field];
  if (content.length > characterLimit) {
    throw new InputError("content exceeds character_limit", 400, {
      character_limit: characterLimit,
      content_length: content.length,
    });
  }
  await tx`
    UPDATE journey_prompt_versions SET is_active = false
     WHERE field = ${field} AND ${tx(column)} = ${ownerId} AND is_active = true
  `;
  const [row] = await tx`
    INSERT INTO journey_prompt_versions
      (field, ${tx(column)}, content, character_limit, version, is_active, created_by, created_at)
    VALUES (${field}, ${ownerId}, ${content}, ${characterLimit}, ${next_version}, true, ${adminId}, now())
    RETURNING id
  `;
  return row.id;
}

async function fetchVersion(sql, id) {
  const rows = await sql`
    SELECT v.id, v.field, v.journey_id, v.cluster_id, v.content, v.character_limit,
           v.version, v.is_active, v.created_at, u.email AS created_by_email
      FROM journey_prompt_versions v LEFT JOIN users u ON u.id = v.created_by
     WHERE v.id = ${id}
  `;
  return rows[0] ? shapeVersion(rows[0]) : null;
}

async function journeyExists(tx, id) {
  const rows = await tx`SELECT id FROM journeys WHERE id = ${id}`;
  if (rows.length === 0) throw new InputError("Journey not found", 404);
}

async function keyTaken(tx, table, key) {
  const rows =
    table === "journeys"
      ? await tx`SELECT 1 FROM journeys WHERE key = ${key}`
      : await tx`SELECT 1 FROM journey_clusters WHERE key = ${key}`;
  return rows.length > 0;
}

async function feedbackCounts(sql, days) {
  const since = days === null ? null : new Date(Date.now() - days * 86400000).toISOString();
  // journeys_seen / clusters_seen are written by textGeneration since
  // migration 024; older sessions fall back to the last routed journey and
  // situation in metadata.routing.route.
  return sql`
    WITH fb AS (
      SELECT sf.rating, cs.metadata->'routing' AS r
        FROM session_feedback sf
        JOIN chat_sessions cs ON cs.id = sf.chat_session_id
       WHERE (${since}::timestamptz IS NULL OR sf.updated_at >= ${since}::timestamptz)
         -- Evaluation-harness sessions (migration 035) are test traffic.
         AND cs.eval_run_id IS NULL
    ),
    tagged AS (
      SELECT rating,
        CASE
          WHEN jsonb_typeof(r->'journeys_seen') = 'array' AND jsonb_array_length(r->'journeys_seen') > 0
            THEN r->'journeys_seen'
          WHEN COALESCE(r->'route'->>'journey', 'UNCLEAR') NOT IN ('UNCLEAR', 'BOTH')
            THEN jsonb_build_array(r->'route'->>'journey')
          ELSE '[]'::jsonb
        END AS journeys,
        CASE
          WHEN jsonb_typeof(r->'clusters_seen') = 'array' AND jsonb_array_length(r->'clusters_seen') > 0
            THEN r->'clusters_seen'
          ELSE (
            SELECT COALESCE(jsonb_agg(DISTINCT s), '[]'::jsonb)
              FROM (VALUES (r->'route'->>'situation'), (r->'route'->>'secondary_situation')) AS x(s)
             WHERE s IS NOT NULL AND s NOT IN ('UNKNOWN', 'NONE')
          )
        END AS clusters
      FROM fb
    )
    SELECT 'journey' AS kind, k AS key,
           COUNT(*) FILTER (WHERE rating = 'up')::int AS up,
           COUNT(*) FILTER (WHERE rating = 'down')::int AS down,
           COUNT(*)::int AS sessions
      FROM tagged, jsonb_array_elements_text(journeys) AS k
     GROUP BY k
    UNION ALL
    SELECT 'cluster', k,
           COUNT(*) FILTER (WHERE rating = 'up')::int,
           COUNT(*) FILTER (WHERE rating = 'down')::int,
           COUNT(*)::int
      FROM tagged, jsonb_array_elements_text(clusters) AS k
     GROUP BY k
    UNION ALL
    SELECT 'untagged', NULL,
           COUNT(*) FILTER (WHERE rating = 'up')::int,
           COUNT(*) FILTER (WHERE rating = 'down')::int,
           COUNT(*)::int
      FROM tagged
     WHERE jsonb_array_length(journeys) = 0 AND jsonb_array_length(clusters) = 0
  `;
}

// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------

const ROUTES = new Set([
  "GET /admin/journeys",
  "POST /admin/journeys",
  "GET /admin/journeys/feedback",
  "PUT /admin/journeys/{journey_id}",
  "POST /admin/journeys/{journey_id}/clusters",
  "PUT /admin/clusters/{cluster_id}",
  "POST /admin/journey-prompts",
  "DELETE /admin/journey-prompts/{version_id}",
  "POST /admin/journey-prompts/{version_id}/activate",
]);

const isJourneyRoute = (routeKey) => ROUTES.has(routeKey);

function parseJson(body) {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new InputError("Invalid JSON body");
  }
}

async function route(sql, event, routeKey) {
  const params = event.pathParameters ?? {};

  switch (routeKey) {
    case "GET /admin/journeys":
      return { statusCode: 200, body: { journeys: await fetchTree(sql) } };

    case "GET /admin/journeys/feedback": {
      const days = parseFeedbackRange(event.queryStringParameters?.timeRange);
      const [counts, journeyRows, clusterRows] = await Promise.all([
        feedbackCounts(sql, days),
        sql`SELECT id, key, name, is_archived FROM journeys ORDER BY sort_order, key`,
        sql`SELECT id, journey_id, key, name, is_archived FROM journey_clusters ORDER BY sort_order, key`,
      ]);
      return { statusCode: 200, body: shapeFeedback(counts, journeyRows, clusterRows, days) };
    }

    case "POST /admin/journeys": {
      const body = parseJson(event.body);
      const input = validateJourneyInput(body);
      const questions = typeof body.detective_questions === "string" ? body.detective_questions.trim() : "";
      const guidance = typeof body.guidance === "string" ? body.guidance.trim() : "";
      const adminId = await resolveAdmin(sql, event);
      const id = await sql.begin(async (tx) => {
        if (await keyTaken(tx, "journeys", input.key)) {
          throw new InputError(`A journey with key ${input.key} already exists`, 409);
        }
        const [row] = await tx`
          INSERT INTO journeys (key, name, description, detection_signals, sort_order, updated_by)
          VALUES (${input.key}, ${input.name}, ${input.description ?? ""}, ${input.detection_signals ?? ""},
                  ${input.sort_order ?? 0}, ${adminId})
          RETURNING id
        `;
        if (questions) await insertVersion(tx, "detective_questions", row.id, questions, adminId);
        if (guidance) await insertVersion(tx, "guidance", row.id, guidance, adminId);
        return row.id;
      });
      return { statusCode: 201, body: { id } };
    }

    case "PUT /admin/journeys/{journey_id}": {
      const id = validateId(params.journey_id, "journey_id");
      const patch = validateJourneyInput(parseJson(event.body), { partial: true });
      const adminId = await resolveAdmin(sql, event);
      await sql.begin(async (tx) => {
        const rows = await tx`SELECT id, is_archived FROM journeys WHERE id = ${id} FOR UPDATE`;
        if (rows.length === 0) throw new InputError("Journey not found", 404);
        if (patch.is_archived === true && !rows[0].is_archived) {
          const [{ others }] = await tx`
            SELECT COUNT(*)::int AS others FROM journeys WHERE is_archived = false AND id <> ${id}
          `;
          if (others === 0) throw new InputError("At least one journey must stay active");
        }
        const columns = Object.keys(patch);
        await tx`
          UPDATE journeys SET ${tx(patch, ...columns)}, updated_at = now(), updated_by = ${adminId}
           WHERE id = ${id}
        `;
      });
      return { statusCode: 200, body: { id } };
    }

    case "POST /admin/journeys/{journey_id}/clusters": {
      const journeyId = validateId(params.journey_id, "journey_id");
      const body = parseJson(event.body);
      const input = validateClusterInput(body);
      const pattern = typeof body.response_pattern === "string" ? body.response_pattern.trim() : "";
      const adminId = await resolveAdmin(sql, event);
      const id = await sql.begin(async (tx) => {
        await journeyExists(tx, journeyId);
        if (await keyTaken(tx, "journey_clusters", input.key)) {
          throw new InputError(`A situation with key ${input.key} already exists`, 409);
        }
        const [row] = await tx`
          INSERT INTO journey_clusters (journey_id, key, name, matches_when, sort_order, updated_by)
          VALUES (${journeyId}, ${input.key}, ${input.name}, ${input.matches_when},
                  ${input.sort_order ?? 0}, ${adminId})
          RETURNING id
        `;
        if (pattern) await insertVersion(tx, "response_pattern", row.id, pattern, adminId);
        return row.id;
      });
      return { statusCode: 201, body: { id } };
    }

    case "PUT /admin/clusters/{cluster_id}": {
      const id = validateId(params.cluster_id, "cluster_id");
      const patch = validateClusterInput(parseJson(event.body), { partial: true });
      const adminId = await resolveAdmin(sql, event);
      const columns = Object.keys(patch);
      const updated = await sql`
        UPDATE journey_clusters SET ${sql(patch, ...columns)}, updated_at = now(), updated_by = ${adminId}
         WHERE id = ${id}
        RETURNING id
      `;
      if (updated.length === 0) throw new InputError("Situation not found", 404);
      return { statusCode: 200, body: { id } };
    }

    case "POST /admin/journey-prompts": {
      // field/owner in the body: API Gateway cannot have sibling path
      // parameters ({field} next to {version_id}) at the same level.
      const body = parseJson(event.body);
      const field = validateField(body.field);
      const ownerId = validateId(body.owner_id, "owner_id");
      const content = validatePromptContent(body);
      const adminId = await resolveAdmin(sql, event);
      const id = await sql.begin(async (tx) => {
        const owner = JOURNEY_FIELDS.includes(field)
          ? await tx`SELECT id FROM journeys WHERE id = ${ownerId} FOR UPDATE`
          : await tx`SELECT id FROM journey_clusters WHERE id = ${ownerId} FOR UPDATE`;
        if (owner.length === 0) throw new InputError("Journey or situation not found", 404);
        return insertVersion(tx, field, ownerId, content, adminId);
      });
      return { statusCode: 200, body: await fetchVersion(sql, id) };
    }

    case "DELETE /admin/journey-prompts/{version_id}": {
      const id = validateId(params.version_id, "version_id");
      await resolveAdmin(sql, event);
      const result = await sql.begin(async (tx) => {
        const rows = await tx`
          SELECT id, field, version, is_active FROM journey_prompt_versions WHERE id = ${id} FOR UPDATE
        `;
        if (rows.length === 0) throw new InputError("Prompt version not found", 404);
        if (rows[0].is_active) throw new InputError("Cannot delete the active version");
        await tx`DELETE FROM journey_prompt_versions WHERE id = ${id}`;
        return rows[0];
      });
      return {
        statusCode: 200,
        body: { success: true, deleted: { id: result.id, field: result.field, version: result.version } },
      };
    }

    case "POST /admin/journey-prompts/{version_id}/activate": {
      const id = validateId(params.version_id, "version_id");
      await resolveAdmin(sql, event);
      const status = await sql.begin(async (tx) => {
        const rows = await tx`
          SELECT id, field, journey_id, cluster_id, is_active
            FROM journey_prompt_versions WHERE id = ${id} FOR UPDATE
        `;
        if (rows.length === 0) throw new InputError("Prompt version not found", 404);
        const target = rows[0];
        if (target.is_active) return "already_active";
        const column = ownerColumn(target.field);
        const ownerId = target.journey_id ?? target.cluster_id;
        await tx`
          UPDATE journey_prompt_versions SET is_active = false
           WHERE field = ${target.field} AND ${tx(column)} = ${ownerId} AND is_active = true
        `;
        await tx`UPDATE journey_prompt_versions SET is_active = true WHERE id = ${id}`;
        return "activated";
      });
      return { statusCode: 200, body: { success: true, status, activated: await fetchVersion(sql, id) } };
    }

    default:
      return null;
  }
}

/**
 * Handle a journey route. Writes statusCode/body onto `response` and returns
 * true, or returns false if `routeKey` is not a journey route.
 */
async function handleJourneyRequest(sql, event, routeKey, response) {
  if (!isJourneyRoute(routeKey)) return false;
  try {
    const result = await route(sql, event, routeKey);
    response.statusCode = result.statusCode;
    response.body = JSON.stringify(result.body);
  } catch (error) {
    if (error instanceof InputError) {
      response.statusCode = error.statusCode;
      response.body = JSON.stringify({ error: error.message, ...error.extra });
    } else if (error?.code === "23505") {
      response.statusCode = 409;
      response.body = JSON.stringify({ error: "That key or version already exists" });
    } else if (error?.code === "42P01") {
      // Undefined table: migration 024 has not run yet.
      response.statusCode = 503;
      response.body = JSON.stringify({ error: "Journey tables are not set up yet. Run the database migrations." });
    } else {
      console.error(`${routeKey} failed:`, error?.code ?? error?.name ?? "error");
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  }
  return true;
}

module.exports = {
  KEY_PATTERN,
  RESERVED_KEYS,
  PROMPT_FIELDS,
  DEFAULT_CHARACTER_LIMITS,
  InputError,
  validateKey,
  validateJourneyInput,
  validateClusterInput,
  validatePromptContent,
  validateField,
  parseFeedbackRange,
  shapeTree,
  shapeFeedback,
  isJourneyRoute,
  handleJourneyRequest,
};
