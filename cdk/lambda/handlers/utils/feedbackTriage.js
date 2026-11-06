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
 *   GET /admin/feedback/{chat_session_id}/message   -> { message, inferred }
 *     Only the assistant reply that was rated, not the whole conversation.
 *
 * Privacy: the triage route never returns or logs comment text. Comment text
 * is only returned to admins through GET /admin/analytics (fetchFeedbackLists).
 * Both routes log status only (adminHandler logAndReturn).
 */

const { validateUUID } = require("./validation.js");
const { errorSummary } = require("./logging.js");
const { auditEntry, insertAdminAudit, logAdminAudit } = require("./adminAudit.js");

const TRIAGE_ROUTE = "PUT /admin/feedback/{chat_session_id}";
const RATED_MESSAGE_ROUTE = "GET /admin/feedback/{chat_session_id}/message";
const TRIAGE_FIELDS = ["starred", "dismissed"];

const RECENT_LIMIT = 50;
const STARRED_LIMIT = 100;
const DISMISSED_LIMIT = 50;

class InputError extends Error {}

/** True for every route this module handles (both log status only). */
function isFeedbackTriageRoute(pathData) {
  return pathData === TRIAGE_ROUTE || pathData === RATED_MESSAGE_ROUTE;
}

/**
 * The assistant reply a piece of feedback was left on. Uses the stored link
 * (migration 030); older feedback without one falls back to the last AI reply
 * saved before the feedback was last updated (`inferred: true`).
 * Returns { found: false } when the session has no feedback.
 */
async function fetchRatedMessage(sql, chatSessionId) {
  const rows = await sql`
    SELECT
      (sf.chat_message_id IS NULL) AS inferred,
      m.id::text AS id,
      m.content,
      m.created_at
    FROM session_feedback sf
    LEFT JOIN LATERAL (
      SELECT cm.id, cm.content, cm.created_at
      FROM chat_messages cm
      WHERE cm.chat_session_id = sf.chat_session_id
        AND cm.sender = 'AI'
        AND (
          cm.id = sf.chat_message_id
          OR (sf.chat_message_id IS NULL AND cm.created_at <= sf.updated_at)
        )
      ORDER BY cm.created_at DESC
      LIMIT 1
    ) m ON true
    WHERE sf.chat_session_id = ${chatSessionId}
  `;
  if (rows.length === 0) return { found: false };
  const row = rows[0];
  return {
    found: true,
    inferred: Boolean(row.inferred),
    message: row.id
      ? { id: row.id, sender: "AI", content: row.content, created_at: row.created_at }
      : null,
  };
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
    const idCheck = validateUUID(event.pathParameters?.chat_session_id, "chat_session_id");
    if (!idCheck.valid) {
      send(400, { error: idCheck.error });
      return true;
    }
    const chatSessionId = idCheck.value;

    if (pathData === RATED_MESSAGE_ROUTE) {
      const result = await fetchRatedMessage(sql, chatSessionId);
      if (!result.found) {
        send(404, { error: "Feedback not found" });
      } else {
        send(200, { message: result.message, inferred: result.inferred });
      }
      return true;
    }

    const changes = validateTriageBody(parseJsonBody(event.body));
    // Triage and its admin_audit row commit together (finding f-c47d6990).
    let audit;
    const saved = await sql.begin(async (tx) => {
      const row = await updateTriage(tx, chatSessionId, changes);
      if (row) {
        audit = auditEntry(event, "feedback.triage", {
          chat_session_id: row.chat_session_id, starred: row.starred, dismissed: row.dismissed,
        });
        await insertAdminAudit(tx, audit);
      }
      return row;
    });
    if (!saved) {
      send(404, { error: "Feedback not found" });
      return true;
    }
    logAdminAudit(audit);
    send(200, saved);
  } catch (err) {
    if (err instanceof InputError) {
      send(400, { error: err.message });
    } else {
      // Error summary only; never the request body or DB error detail.
      console.error(`${pathData} error:`, errorSummary(err));
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
  RATED_MESSAGE_ROUTE,
  fetchRatedMessage,
  validateTriageBody,
  triageActions,
  isFeedbackTriageRoute,
  handleFeedbackTriageRequest,
  fetchFeedbackLists,
};
