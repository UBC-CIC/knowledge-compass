/**
 * Admin triage for end-of-conversation feedback (session_feedback).
 *
 *   PUT /admin/feedback/{chat_session_id}   body: { starred?: boolean, dismissed?: boolean }
 *
 * Star / dismiss state is shared by all admins (migration 029):
 *   - starred_at / dismissed_at are NULL when not set.
 *   - Dismissing also removes the star, so each comment sits in one list.
 *   - Dismissed feedback still counts toward thumbs up/down totals.
 *   - The public feedback upsert (chatSessionHandler.js) clears dismissed_at
 *     when the user edits their feedback; the star is kept.
 *
 * Privacy: the triage route never returns or logs comment text. Comment text
 * is only returned to admins through GET /admin/analytics (fetchFeedbackLists).
 */

const { validateUUID } = require("./validation.js");

const TRIAGE_ROUTE = "PUT /admin/feedback/{chat_session_id}";
const TRIAGE_FIELDS = ["starred", "dismissed"];

const RECENT_LIMIT = 50;
const STARRED_LIMIT = 100;
const DISMISSED_LIMIT = 50;

class InputError extends Error {}

function isFeedbackTriageRoute(pathData) {
  return pathData === TRIAGE_ROUTE;
}

/**
 * Parses and validates a triage body. Returns { starred?, dismissed? } with at
 * least one boolean field; throws InputError otherwise.
 */
function validateTriageBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InputError("Request body must be a JSON object");
  }
  const unknown = Object.keys(body).filter((k) => !TRIAGE_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw new InputError(`Unknown field(s): ${unknown.join(", ")}`);
  }
  const out = {};
  for (const field of TRIAGE_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "boolean") {
      throw new InputError(`${field} must be a boolean`);
    }
    out[field] = body[field];
  }
  if (Object.keys(out).length === 0) {
    throw new InputError("Provide starred and/or dismissed");
  }
  return out;
}

function parseJsonBody(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new InputError("Invalid JSON body");
  }
}

/**
 * Maps validated changes to a column action: "set", "clear" or "keep".
 * Dismissing removes the star, whatever `starred` says.
 */
function triageActions({ starred, dismissed }) {
  const toAction = (v) => (v === true ? "set" : v === false ? "clear" : "keep");
  return {
    star: dismissed === true ? "clear" : toAction(starred),
    dismiss: toAction(dismissed),
  };
}

async function updateTriage(sql, chatSessionId, changes) {
  const { star, dismiss } = triageActions(changes);
  // COALESCE keeps the original timestamp when a row is starred/dismissed again.
  const rows = await sql`
    UPDATE session_feedback SET
      starred_at = CASE ${star}::text
        WHEN 'set' THEN COALESCE(starred_at, now())
        WHEN 'clear' THEN NULL
        ELSE starred_at
      END,
      dismissed_at = CASE ${dismiss}::text
        WHEN 'set' THEN COALESCE(dismissed_at, now())
        WHEN 'clear' THEN NULL
        ELSE dismissed_at
      END
    WHERE chat_session_id = ${chatSessionId}
    RETURNING
      chat_session_id::text AS chat_session_id,
      (starred_at IS NOT NULL) AS starred,
      (dismissed_at IS NOT NULL) AS dismissed
  `;
  return rows[0] ?? null;
}

/**
 * Handles the triage route. Returns true when the route was handled (response
 * filled in), false for any other route.
 */
async function handleFeedbackTriageRequest(sql, event, pathData, response) {
  if (!isFeedbackTriageRoute(pathData)) return false;

  const send = (statusCode, body) => {
    response.statusCode = statusCode;
    response.body = JSON.stringify(body);
  };

  try {
    const chatSessionId = event.pathParameters?.chat_session_id;
    const idCheck = validateUUID(chatSessionId, "chat_session_id");
    if (!idCheck.valid) {
      send(400, { error: idCheck.error });
      return true;
    }

    const changes = validateTriageBody(parseJsonBody(event.body));
    const saved = await updateTriage(sql, chatSessionId.trim(), changes);
    if (!saved) {
      send(404, { error: "Feedback not found" });
      return true;
    }
    send(200, saved);
  } catch (err) {
    if (err instanceof InputError) {
      send(400, { error: err.message });
    } else {
      // Error only; never the request body.
      console.error("PUT /admin/feedback error:", err?.message ?? err);
      send(500, { error: "Internal server error" });
    }
  }
  return true;
}

/**
 * Written feedback lists for the admin Analytics page.
 *   - recentFeedback:    in range, not dismissed (with a starred flag)
 *   - starredFeedback:   starred and not dismissed, any date
 *   - dismissedFeedback: dismissed, in range
 */
async function fetchFeedbackLists(sql, startDateIso, endDateIso) {
  const [recentFeedback, starredFeedback, dismissedFeedback] = await Promise.all([
    sql`
      SELECT
        sf.chat_session_id::text AS chat_session_id,
        sf.rating,
        sf.comment,
        sf.updated_at,
        (sf.starred_at IS NOT NULL) AS starred
      FROM session_feedback sf
      WHERE sf.updated_at >= ${startDateIso}
        AND sf.updated_at < ${endDateIso}
        AND sf.comment IS NOT NULL
        AND sf.dismissed_at IS NULL
      ORDER BY sf.updated_at DESC
      LIMIT ${RECENT_LIMIT}
    `,
    sql`
      SELECT
        sf.chat_session_id::text AS chat_session_id,
        sf.rating,
        sf.comment,
        sf.updated_at,
        true AS starred,
        sf.starred_at
      FROM session_feedback sf
      WHERE sf.starred_at IS NOT NULL
        AND sf.dismissed_at IS NULL
        AND sf.comment IS NOT NULL
      ORDER BY sf.starred_at DESC
      LIMIT ${STARRED_LIMIT}
    `,
    sql`
      SELECT
        sf.chat_session_id::text AS chat_session_id,
        sf.rating,
        sf.comment,
        sf.updated_at,
        false AS starred,
        sf.dismissed_at
      FROM session_feedback sf
      WHERE sf.dismissed_at IS NOT NULL
        AND sf.comment IS NOT NULL
        AND sf.updated_at >= ${startDateIso}
        AND sf.updated_at < ${endDateIso}
      ORDER BY sf.dismissed_at DESC
      LIMIT ${DISMISSED_LIMIT}
    `,
  ]);
  return { recentFeedback, starredFeedback, dismissedFeedback };
}

module.exports = {
  TRIAGE_ROUTE,
  validateTriageBody,
  triageActions,
  isFeedbackTriageRoute,
  handleFeedbackTriageRequest,
  fetchFeedbackLists,
};
