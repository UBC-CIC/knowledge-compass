/**
 * AWS Lambda Handler for Admin Operations
 *
 * This Lambda function handles HTTP requests for administrative operations including:
 * - Admin user management (create, read, update, delete)
 * - System administration tasks
 * - Content management operations
 *
 * This handler requires admin-level authentication via AWS Cognito.
 * Only authenticated admin users can access these endpoints.
 */

const postgres = require("postgres");
const { getCorsHeaders } = require("./utils/cors.js");
const { handleJourneyRequest } = require("./utils/journeyPrompts.js");
const { logResponse, errorSummary } = require("./utils/logging.js");
const { adminSubFromEvent, resolveAdminUser } = require("./utils/adminIdentity.js");
const { ensureStaffUser, normalizeEmail } = require("../authorization/staffIdentity.js");
const { auditEntry, insertAdminAudit, logAdminAudit } = require("./utils/adminAudit.js");
const {
  handleFeedbackTriageRequest,
  fetchFeedbackLists,
} = require("./utils/feedbackTriage.js");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

// Editable system_messages types. Must match the types read by
// textGeneration/helpers/config.py plus the UI-only welcome_message/disclaimer.
const SYSTEM_MESSAGE_TYPES = new Set([
  "system_role",
  "guardrails",
  "language_guidelines",
  "detective_phase_prompt",
  "suggestion_phase_prompt",
  "output_format_detective",
  "output_format_suggestion",
  "output_format_partial",
  "welcome_message",
  "disclaimer",
]);

const UI_ONLY_SYSTEM_MESSAGE_TYPES = new Set(["welcome_message", "disclaimer"]);

// Used only when a type has no existing row to inherit character_limit from.
// Mirrors the limits seeded in migrations 002/004/010.
const DEFAULT_CHARACTER_LIMITS = {
  system_role: 2000,
  guardrails: 2000,
  language_guidelines: 6000,
  detective_phase_prompt: 4000,
  suggestion_phase_prompt: 6000,
  output_format_detective: 1000,
  output_format_suggestion: 3500,
  output_format_partial: 3500,
  welcome_message: 2000,
  disclaimer: 700,
};

let sqlConnection;
const secretsManager = new SecretsManagerClient();

const initConnection = async () => {
  if (!sqlConnection) {
    try {
      const getSecretValueCommand = new GetSecretValueCommand({
        SecretId: process.env.SM_DB_CREDENTIALS,
      });
      const secretResponse = await secretsManager.send(getSecretValueCommand);
      const credentials = JSON.parse(secretResponse.SecretString);

      const connectionConfig = {
        host: process.env.RDS_PROXY_ENDPOINT,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        database: credentials.dbname,
        ssl: { rejectUnauthorized: true },
      };

      sqlConnection = postgres(connectionConfig);
      await sqlConnection`SELECT 1`;
      console.log("Database connection initialized successfully");
    } catch (error) {
      console.error("Error initializing database connection:", errorSummary(error));
      throw error;
    }
  }
};

const createResponse = async (event) => ({
    statusCode: 200,
    headers: await getCorsHeaders(event),
    body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", errorSummary(error));
  response.body = JSON.stringify({ error: "Internal server error" });
};

/**
 * Main Lambda handler function
 * @param {Object} event - AWS Lambda event object containing HTTP request data
 * @returns {Object} HTTP response object with statusCode, headers, and body
 */
exports.handler = async (event) => {
  const response = await createResponse(event);

  const callerRole = event.requestContext?.authorizer?.role;
  if (callerRole !== 'admin') {
    response.statusCode = 403;
    response.body = JSON.stringify({ error: 'Admin access required' });
    return logAndReturn(event, response);
  }

  // Ensure database connection is ready
  await initConnection();

  let data; // Variable to store response data
  try {
    // Route requests based on HTTP method and URL path
    // event.httpMethod: GET, POST, PUT, DELETE
    // event.resource: URL pattern like /admin/users
    const pathData = event.httpMethod + " " + event.resource;

    // Journeys, situation clusters, their prompt versions and feedback counts
    // (utils/journeyPrompts.js). Handles its own errors.
    if (await handleJourneyRequest(sqlConnection, event, pathData, response)) {
      return logAndReturn(event, response);
    }

    // Star / dismiss user feedback (utils/feedbackTriage.js). Handles its own errors.
    if (await handleFeedbackTriageRequest(sqlConnection, event, pathData, response)) {
      return logAndReturn(event, response);
    }

    // Handle different API endpoints using switch statement
    switch (pathData) {
      // POST /admin/promote_user - Ensure the signed-in admin exists in users.
      // Acts only on the caller, identified by the Cognito sub; body email,
      // role and user_id are ignored (the authorizer already proved admin
      // group membership). Never keyed on users.email, which guests can write.
      case "POST /admin/promote_user": {
        try {
          parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const adminSub = adminSubFromEvent(event);
        if (!adminSub) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }
        const adminEmail = normalizeEmail(event.requestContext?.authorizer?.email);

        // The audit row is written in ensureStaffUser's transaction, so the
        // role change and its record commit or roll back together.
        let promoteAudit;
        const ensured = await ensureStaffUser(sqlConnection, {
          sub: adminSub,
          email: adminEmail,
          displayName: adminEmail,
          role: "admin",
          elevate: true,
          onWrite: (tx, row) => {
            promoteAudit = auditEntry(event, "admin.promote_user", {
              user_id: row.id,
              outcome: row.outcome,
              role: row.role,
            });
            return insertAdminAudit(tx, promoteAudit);
          },
        });
        logAdminAudit(promoteAudit);

        const updated = await sqlConnection`
          SELECT
            id,
            email,
            display_name,
            role,
            created_at,
            last_seen_at,
            messages_sent,
            messages_window_started_at,
            metadata
          FROM users
          WHERE id = ${ensured.id}
        `;

        response.statusCode = 200;
        response.body = JSON.stringify(updated[0]);
        break;
      }

      // Fetch all system messages with version history
      case "GET /admin/system-messages": {
        const rows = await sqlConnection`
          SELECT
            sm.id,
            sm.type,
            sm.content,
            sm.character_limit,
            sm.version,
            sm.is_active,
            sm.affects_text_generation,
            sm.created_by,
            sm.created_at,
            u.email AS created_by_email
          FROM system_messages sm
          LEFT JOIN users u ON u.id = sm.created_by
          ORDER BY
            sm.type ASC,
            sm.is_active DESC,
            sm.version DESC,
            sm.created_at DESC
        `;

        // Group into { [type]: SystemMessageVersion[] }
        const grouped = {};
        for (const r of rows) {
          if (!grouped[r.type]) grouped[r.type] = [];
          grouped[r.type].push({
            id: r.id,
            type: r.type,
            content: r.content,
            character_limit: r.character_limit,
            version: r.version,
            is_active: r.is_active,
            affects_text_generation: r.affects_text_generation,
            created_by: r.created_by ?? null,
            created_by_email: r.created_by_email ?? null,
            created_at: r.created_at,
          });
        }

        response.statusCode = 200;
        response.body = JSON.stringify(grouped);
        break;
      }

      // Create new system message version + set active
      case "POST /admin/system-messages/{system_message_type}": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const messageType = event?.pathParameters?.system_message_type;

        const allowedTypes = SYSTEM_MESSAGE_TYPES;

        // Validate system_message_type
        if (!messageType || typeof messageType !== "string" || !allowedTypes.has(messageType)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid system_message_type",
            allowed: Array.from(allowedTypes),
          });
          break;
        }

        // Validate content
        const content = typeof body?.content === "string" ? body.content.trim() : "";
        if (!content) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "content is required" });
          break;
        }

        // Find admin user id by Cognito sub (ensure role is admin)
        const admin = await resolveAdminUser(sqlConnection, event);
        if (admin.error) {
          response.statusCode = admin.statusCode;
          response.body = JSON.stringify({ error: admin.error });
          break;
        }

        const createdByUserId = admin.id;

        // Create new version, make it active, deactivate old
        try {
          const created = await sqlConnection.begin(async (tx) => {
            const [{ next_version }] = await tx`
              SELECT COALESCE(MAX(version), 0) + 1 AS next_version
              FROM system_messages
              WHERE type = ${messageType}::system_message_type
            `;

            const limitRows = await tx`
              SELECT character_limit
              FROM system_messages
              WHERE type = ${messageType}::system_message_type
              ORDER BY is_active DESC, version DESC, created_at DESC
              LIMIT 1
            `;

            const defaultCharacterLimit =
              DEFAULT_CHARACTER_LIMITS[messageType] ?? 700;

            const characterLimit =
              limitRows.length > 0 && typeof limitRows[0].character_limit === "number"
                ? limitRows[0].character_limit
                : defaultCharacterLimit;

            if (content.length > characterLimit) {
              return {
                kind: "too_long",
                character_limit: characterLimit,
                content_length: content.length,
              };
            }

            await tx`
              UPDATE system_messages
              SET is_active = false
              WHERE type = ${messageType}::system_message_type
                AND is_active = true
            `;

            const inserted = await tx`
              INSERT INTO system_messages (
                type,
                content,
                character_limit,
                version,
                is_active,
                affects_text_generation,
                created_by,
                created_at
              )
              VALUES (
                ${messageType}::system_message_type,
                ${content},
                ${characterLimit},
                ${next_version},
                true,
                ${!UI_ONLY_SYSTEM_MESSAGE_TYPES.has(messageType)},
                ${createdByUserId},
                NOW()
              )
              RETURNING id
            `;

            const out = await tx`
              SELECT
                sm.id,
                sm.type,
                sm.content,
                sm.character_limit,
                sm.version,
                sm.is_active,
                sm.affects_text_generation,
                sm.created_by,
                u.email AS created_by_email,
                sm.created_at
              FROM system_messages sm
              LEFT JOIN users u ON u.id = sm.created_by
              WHERE sm.id = ${inserted[0].id}
              LIMIT 1
            `;

            const audit = auditEntry(event, "system_message.create", {
              id: inserted[0].id,
              type: messageType,
              version: next_version,
            });
            await insertAdminAudit(tx, audit);

            return {
              kind: "created",
              row: out[0],
              audit,
            };
          });

          if (created.kind === "too_long") {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "content exceeds character_limit",
              character_limit: created.character_limit,
              content_length: created.content_length,
            });
            break;
          }

          logAdminAudit(created.audit);
          response.statusCode = 200;
          response.body = JSON.stringify(created.row);
          break;
        } catch (err) {
          console.error("POST /admin/system-messages/{system_message_type} failed:", errorSummary(err));
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Failed to create system message version" });
          break;
        }
      }

      // Delete a non-active system message version
      case "DELETE /admin/system-messages/{system_message_type}/{version_id}": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const messageType = event?.pathParameters?.system_message_type;
        const versionId = event?.pathParameters?.version_id;

        const allowedTypes = SYSTEM_MESSAGE_TYPES;

        // Validate path params
        if (!messageType || typeof messageType !== "string" || !allowedTypes.has(messageType)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid system_message_type",
            allowed: Array.from(allowedTypes),
          });
          break;
        }

        if (!versionId || typeof versionId !== "string") {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "version_id is required" });
          break;
        }

        // Find admin user by Cognito sub (ensure role is admin)
        const admin = await resolveAdminUser(sqlConnection, event);
        if (admin.error) {
          response.statusCode = admin.statusCode;
          response.body = JSON.stringify({ error: admin.error });
          break;
        }

        try {
          const deleted = await sqlConnection.begin(async (tx) => {
            const targetRows = await tx`
              SELECT id, type, version, is_active
              FROM system_messages
              WHERE id = ${versionId}
                AND type = ${messageType}::system_message_type
              FOR UPDATE
            `;

            if (targetRows.length === 0) {
              return { kind: "not_found" };
            }

            const target = targetRows[0];

            if (target.is_active) {
              return { kind: "active_forbidden", version: target.version };
            }

            const removed = await tx`
              DELETE FROM system_messages
              WHERE id = ${versionId}
                AND type = ${messageType}::system_message_type
              RETURNING id, type, version
            `;

            if (removed.length === 0) {
              return { kind: "not_found" };
            }

            const audit = auditEntry(event, "system_message.delete", {
              id: removed[0].id,
              type: removed[0].type,
              version: removed[0].version,
            });
            await insertAdminAudit(tx, audit);

            return {
              kind: "deleted",
              id: removed[0].id,
              type: removed[0].type,
              version: removed[0].version,
              audit,
            };
          });

          if (deleted.kind === "not_found") {
            response.statusCode = 404;
            response.body = JSON.stringify({
              error: "System message version not found for given type/version_id",
            });
            break;
          }

          if (deleted.kind === "active_forbidden") {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "Cannot delete the active version",
              version: deleted.version,
            });
            break;
          }

          logAdminAudit(deleted.audit);
          response.statusCode = 200;
          response.body = JSON.stringify({
            success: true,
            deleted: {
              id: deleted.id,
              type: deleted.type,
              version: deleted.version,
            },
          });
          break;
        } catch (err) {
          console.error("DELETE /admin/system-messages/{system_message_type}/{version_id} failed:", errorSummary(err));
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Failed to delete system message version" });
          break;
        }
      }

      // Activate a historical version
      case "POST /admin/system-messages/{system_message_type}/{version_id}/activate": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const messageType = event?.pathParameters?.system_message_type;
        const versionId = event?.pathParameters?.version_id;

        const allowedTypes = SYSTEM_MESSAGE_TYPES;

        // Validate path params
        if (!messageType || typeof messageType !== "string" || !allowedTypes.has(messageType)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid system_message_type",
            allowed: Array.from(allowedTypes),
          });
          break;
        }

        if (!versionId || typeof versionId !== "string") {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "version_id is required" });
          break;
        }

        // Find admin user by Cognito sub (ensure role is admin)
        const admin = await resolveAdminUser(sqlConnection, event);
        if (admin.error) {
          response.statusCode = admin.statusCode;
          response.body = JSON.stringify({ error: admin.error });
          break;
        }

        try {
          const result = await sqlConnection.begin(async (tx) => {
            // Lock target row and verify it exists + belongs to specified type
            const targetRows = await tx`
              SELECT id, type, version, is_active
              FROM system_messages
              WHERE id = ${versionId}
                AND type = ${messageType}::system_message_type
              FOR UPDATE
            `;

            if (targetRows.length === 0) {
              return { kind: "not_found" };
            }

            const target = targetRows[0];

            // If already active, return success
            if (target.is_active) {
              const out = await tx`
                SELECT
                  sm.id,
                  sm.type,
                  sm.content,
                  sm.character_limit,
                  sm.version,
                  sm.is_active,
                  sm.affects_text_generation,
                  sm.created_by,
                  u.email AS created_by_email,
                  sm.created_at
                FROM system_messages sm
                LEFT JOIN users u ON u.id = sm.created_by
                WHERE sm.id = ${target.id}
                LIMIT 1
              `;

              return {
                kind: "already_active",
                activated: out[0],
                previous_active: null,
              };
            }

            // Find currently active version for this type (if any), lock it
            const previousActiveRows = await tx`
              SELECT id, version
              FROM system_messages
              WHERE type = ${messageType}::system_message_type
                AND is_active = true
              FOR UPDATE
            `;

            const previousActive = previousActiveRows[0] ?? null;

            // Deactivate all active rows for this type (defensive, in case of bad data)
            await tx`
              UPDATE system_messages
              SET is_active = false
              WHERE type = ${messageType}::system_message_type
                AND is_active = true
            `;

            // Activate target
            await tx`
              UPDATE system_messages
              SET is_active = true
              WHERE id = ${target.id}
            `;

            const out = await tx`
              SELECT
                sm.id,
                sm.type,
                sm.content,
                sm.character_limit,
                sm.version,
                sm.is_active,
                sm.affects_text_generation,
                sm.created_by,
                u.email AS created_by_email,
                sm.created_at
              FROM system_messages sm
              LEFT JOIN users u ON u.id = sm.created_by
              WHERE sm.id = ${target.id}
              LIMIT 1
            `;

            const audit = auditEntry(event, "system_message.activate", {
              id: target.id,
              type: target.type,
              version: target.version,
              previous_active_id: previousActive ? previousActive.id : null,
            });
            await insertAdminAudit(tx, audit);

            return {
              kind: "activated",
              audit,
              activated: out[0],
              previous_active: previousActive
                ? {
                  id: previousActive.id,
                  version: previousActive.version,
                }
                : null,
            };
          });

          if (result.kind === "not_found") {
            response.statusCode = 404;
            response.body = JSON.stringify({
              error: "System message version not found for given type/version_id",
            });
            break;
          }

          // Both "already_active" and "activated" return 200; only a real
          // activation is audited.
          if (result.kind === "activated") logAdminAudit(result.audit);
          response.statusCode = 200;
          response.body = JSON.stringify({
            success: true,
            status: result.kind === "already_active" ? "already_active" : "activated",
            activated: result.activated,
            previous_active: result.previous_active,
          });
          break;
        } catch (err) {
          console.error("POST /admin/system-messages/{system_message_type}/{version_id}/activate failed:", errorSummary(err));
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Failed to activate system message version" });
          break;
        }
      }

      // POST /admin/users - Create new admin user in the system
      case "POST /admin/users":
        // Parse JSON request body containing new user data
        let userData;
        try {
          userData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        // Extract user fields from request body. Email is stored in the same
        // canonical form as every other writer (trim + lowercase) so a
        // mixed-case address cannot sit beside its lowercase twin
        // (users_email_lower_key, migration 041).
        const { display_name, email, institution_id } = userData;
        const normalizedEmail = normalizeEmail(email);

        // Validate required fields
        if (!display_name || !normalizedEmail) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "display_name and email are required",
          });
          break;
        }

        // The audit actor is the Cognito sub from the admin authorizer.
        if (!adminSubFromEvent(event)) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        // Insert new admin user and its audit row in one transaction
        let createAudit;
        const result = await sqlConnection.begin(async (tx) => {
          const inserted = await tx`
            INSERT INTO users (display_name, email, institution_id, role)
            VALUES (${display_name}, ${normalizedEmail}, ${institution_id || null}, 'admin')
            RETURNING id, display_name, email, role, institution_id, created_at
          `;
          createAudit = auditEntry(event, "admin_user.create", { user_id: inserted[0].id });
          await insertAdminAudit(tx, createAudit);
          return inserted;
        });
        logAdminAudit(createAudit);

        response.statusCode = 201; // Created
        data = result[0];
        response.body = JSON.stringify(data);
        break;

      // Get analytics data
      case "GET /admin/analytics": {
        const qs = event.queryStringParameters ?? {};

        // If timeRange is NOT provided, return all-time totals only (no timeSeries)
        const timeRangeProvided = typeof qs.timeRange === "string" && qs.timeRange.trim().length > 0;

        // Helper: compute totals (either all-time or between startDate and endDate).
        // Evaluation-harness sessions (cs.eval_run_id set, migration 035) are
        // test traffic and are excluded from every count.
        const fetchTotals = async (startDateIso /* string | null */, endDateIso /* string | null */) => {
          if (!startDateIso) {
            const totalsRows = await sqlConnection`
              SELECT
                (SELECT COUNT(DISTINCT cs.user_id)::int FROM chat_sessions cs
                  WHERE cs.eval_run_id IS NULL) AS users,
                (SELECT COUNT(cs.id)::int FROM chat_sessions cs
                  WHERE cs.eval_run_id IS NULL) AS chat_sessions,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm
                  JOIN chat_sessions cs ON cs.id = cm.chat_session_id
                  WHERE cs.eval_run_id IS NULL) AS messages,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm
                  JOIN chat_sessions cs ON cs.id = cm.chat_session_id
                  WHERE cm.sender = 'user' AND cs.eval_run_id IS NULL) AS questions,
                (SELECT COUNT(sf.id)::int FROM session_feedback sf
                  JOIN chat_sessions cs ON cs.id = sf.chat_session_id
                  WHERE sf.rating = 'up' AND cs.eval_run_id IS NULL) AS thumbs_up,
                (SELECT COUNT(sf.id)::int FROM session_feedback sf
                  JOIN chat_sessions cs ON cs.id = sf.chat_session_id
                  WHERE sf.rating = 'down' AND cs.eval_run_id IS NULL) AS thumbs_down
            `;
            return totalsRows[0];
          }

          const totalsRows = await sqlConnection`
            SELECT
              (SELECT COUNT(DISTINCT cs.user_id)::int
              FROM chat_sessions cs
              WHERE cs.created_at >= ${startDateIso}
                AND cs.created_at < ${endDateIso}
                AND cs.eval_run_id IS NULL) AS users,

              (SELECT COUNT(cs.id)::int
              FROM chat_sessions cs
              WHERE cs.created_at >= ${startDateIso}
                AND cs.created_at < ${endDateIso}
                AND cs.eval_run_id IS NULL) AS chat_sessions,

              (SELECT COUNT(cm.id)::int
              FROM chat_messages cm
              JOIN chat_sessions cs ON cs.id = cm.chat_session_id
              WHERE cm.created_at >= ${startDateIso}
                AND cm.created_at < ${endDateIso}
                AND cs.eval_run_id IS NULL) AS messages,

              (SELECT COUNT(cm.id)::int
              FROM chat_messages cm
              JOIN chat_sessions cs ON cs.id = cm.chat_session_id
              WHERE cm.created_at >= ${startDateIso}
                AND cm.created_at < ${endDateIso}
                AND cm.sender = 'user'
                AND cs.eval_run_id IS NULL) AS questions,

              (SELECT COUNT(sf.id)::int
              FROM session_feedback sf
              JOIN chat_sessions cs ON cs.id = sf.chat_session_id
              WHERE sf.updated_at >= ${startDateIso}
                AND sf.updated_at < ${endDateIso}
                AND sf.rating = 'up'
                AND cs.eval_run_id IS NULL) AS thumbs_up,

              (SELECT COUNT(sf.id)::int
              FROM session_feedback sf
              JOIN chat_sessions cs ON cs.id = sf.chat_session_id
              WHERE sf.updated_at >= ${startDateIso}
                AND sf.updated_at < ${endDateIso}
                AND sf.rating = 'down'
                AND cs.eval_run_id IS NULL) AS thumbs_down
          `;
          return totalsRows[0];
        };

        if (!timeRangeProvided) {
          const totals = await fetchTotals(null, null);

          response.statusCode = 200;
          response.body = JSON.stringify({ totals });
          break;
        }

        // time series for provided timeRange (cap 365)
        const timeRange = qs.timeRange || "90d";

        let daysBack = 90;
        const m = String(timeRange).match(/^(\d+)([dmy])$/);
        if (m) {
          const value = parseInt(m[1], 10);
          const unit = m[2];
          if (unit === "d") daysBack = value;
          if (unit === "m") daysBack = value * 30;
          if (unit === "y") daysBack = value * 365;
        }
        daysBack = Math.min(Math.max(1, daysBack), 365);

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - daysBack);
        const startDateIso = startDate.toISOString();

        // Optional end of window, in days ago (e.g. timeRange=10d&endDaysAgo=4 → 10 to 4 days ago).
        // The end day is inclusive; 0 (default) means up to now.
        let endDaysAgo = parseInt(qs.endDaysAgo ?? "0", 10);
        if (isNaN(endDaysAgo)) endDaysAgo = 0;
        endDaysAgo = Math.min(Math.max(0, endDaysAgo), daysBack - 1);

        const endDate = new Date();
        if (endDaysAgo > 0) {
          endDate.setUTCDate(endDate.getUTCDate() - endDaysAgo + 1);
          endDate.setUTCHours(0, 0, 0, 0);
        }
        const endDateIso = endDate.toISOString();

        const timeSeries = await sqlConnection`
          WITH date_series AS (
            SELECT generate_series(
              DATE_TRUNC('day', ${startDateIso}::timestamp),
              DATE_TRUNC('day', ${endDateIso}::timestamp - INTERVAL '1 second'),
              '1 day'::interval
            )::date AS date
          ),
          daily_chat_sessions AS (
            SELECT
              DATE_TRUNC('day', cs.created_at)::date AS date,
              COUNT(cs.id)::int AS chat_sessions,
              COUNT(DISTINCT cs.user_id)::int AS session_users
            FROM chat_sessions cs
            WHERE cs.created_at >= ${startDateIso}
              AND cs.created_at < ${endDateIso}
              AND cs.eval_run_id IS NULL
            GROUP BY DATE_TRUNC('day', cs.created_at)::date
          ),
          daily_questions AS (
            SELECT
              DATE_TRUNC('day', cm.created_at)::date AS date,
              COUNT(cm.id)::int AS questions,
              COUNT(DISTINCT cs.user_id)::int AS question_users
            FROM chat_messages cm
            JOIN chat_sessions cs ON cs.id = cm.chat_session_id
            WHERE cm.created_at >= ${startDateIso}
              AND cm.created_at < ${endDateIso}
              AND cm.sender = 'user'
              AND cs.eval_run_id IS NULL
            GROUP BY DATE_TRUNC('day', cm.created_at)::date
          ),
          daily_feedback AS (
            SELECT
              DATE_TRUNC('day', sf.updated_at)::date AS date,
              COUNT(sf.id) FILTER (WHERE sf.rating = 'up')::int AS thumbs_up,
              COUNT(sf.id) FILTER (WHERE sf.rating = 'down')::int AS thumbs_down
            FROM session_feedback sf
            JOIN chat_sessions cs ON cs.id = sf.chat_session_id
            WHERE sf.updated_at >= ${startDateIso}
              AND sf.updated_at < ${endDateIso}
              AND cs.eval_run_id IS NULL
            GROUP BY DATE_TRUNC('day', sf.updated_at)::date
          )
          SELECT
            TO_CHAR(ds.date, 'Mon DD') AS date,
            COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users,
            COALESCE(dq.questions, 0)::int AS questions,
            COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions,
            COALESCE(df.thumbs_up, 0)::int AS thumbs_up,
            COALESCE(df.thumbs_down, 0)::int AS thumbs_down
          FROM date_series ds
          LEFT JOIN daily_chat_sessions dcs ON ds.date = dcs.date
          LEFT JOIN daily_questions dq ON ds.date = dq.date
          LEFT JOIN daily_feedback df ON ds.date = df.date
          ORDER BY ds.date ASC
        `;

        const totals = await fetchTotals(startDateIso, endDateIso);

        // Written feedback for the admin view: recent (not dismissed), starred
        // (any date) and dismissed. Totals above still include dismissed rows.
        const { recentFeedback, starredFeedback, dismissedFeedback } =
          await fetchFeedbackLists(sqlConnection, startDateIso, endDateIso);

        response.statusCode = 200;
        response.body = JSON.stringify({
          timeSeries,
          totals,
          recentFeedback,
          starredFeedback,
          dismissedFeedback,
        });
        break;
      }

      // Fetches data sources and latest ingestion run per source
      case "GET /admin/data_sources": {
        try {

          const rows = await sqlConnection`
            SELECT
              ds.id::text AS ds_id,
              ds.name AS ds_name,
              ds.type::text AS ds_type,
              ds.created_at::text AS ds_created_at,
              COALESCE(ds.metadata, '{}'::jsonb) AS ds_metadata,
              ds.include_patterns AS ds_include_patterns,
              ds.exclude_patterns AS ds_exclude_patterns,

              ir.id::text AS ir_id,
              ir.data_source_id::text AS ir_data_source_id,
              ir.status::text AS ir_status,
              ir.error_message AS ir_error_message,
              ir.created_at::text AS ir_created_at,
              ir.completed_at::text AS ir_completed_at
            FROM data_sources ds
            LEFT JOIN LATERAL (
              SELECT *
              FROM ingestion_runs ir
              WHERE ir.data_source_id = ds.id
              ORDER BY ir.created_at DESC
              LIMIT 1
            ) ir ON TRUE
            ORDER BY ds.created_at DESC
          `;

          const items = rows.map((r) => {
            const data_source = {
              id: r.ds_id,
              name: r.ds_name,
              type: r.ds_type,
              created_at: r.ds_created_at,
              metadata: r.ds_metadata ?? {},
              include_patterns: r.ds_include_patterns ?? undefined,
              exclude_patterns: r.ds_exclude_patterns ?? undefined,
            };

            const latest_ingestion_run = r.ir_id
              ? {
                id: r.ir_id,
                data_source_id: r.ir_data_source_id,
                status: r.ir_status,
                error_message: r.ir_error_message ?? null,
                created_at: r.ir_created_at,
                completed_at: r.ir_completed_at ?? null,
              }
              : null;

            return { data_source, latest_ingestion_run };
          });

          response.statusCode = 200;
          response.body = JSON.stringify({ items });
          break;
        } catch (err) {
          console.error("GET /admin/data_sources error:", errorSummary(err));
          response.statusCode = 500;
          response.body = JSON.stringify({ message: "Internal Server Error" });
          break;
        }
      }

      // Fetch latest system settings
      case "GET /admin/system-settings": {
        const rows = await sqlConnection`
          WITH latest AS (
            SELECT *
            FROM system_settings
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
          )
          SELECT
            latest.id,
            latest.max_messages_per_day,
            latest.min_messages_before_suggest,
            latest.routing_mode,
            latest.min_exchanges_before_answer,
            latest.max_characters_per_user_message,
            latest.max_characters_per_day,
            latest.max_messages_per_day_global,
            latest.max_characters_per_ai_message,
            latest.temperature,
            latest.top_p,
            latest.support_score_threshold,
            latest.scope_alignment_score_threshold,
            latest.grounded_threshold,
            latest.partially_grounded_threshold,
            latest.service_status,
            latest.service_message,
            u.email AS updated_by_email,
            latest.updated_at
          FROM latest
          LEFT JOIN users u ON u.id = latest.updated_by
        `;

        // But keep a safe fallback to avoid crashing UI. Keep in sync with
        // textGeneration/helpers/config.py and frontend lib/assistantSettings.ts.
        const fallback = {
          max_messages_per_day: 45,
          min_messages_before_suggest: 4,
          routing_mode: "fixed",
          min_exchanges_before_answer: 0,
          max_characters_per_user_message: 2000,
          max_characters_per_day: 10000,
          max_messages_per_day_global: 5000,
          max_characters_per_ai_message: 5000,
          temperature: 0.15,
          top_p: 0.5,
          support_score_threshold: 0.25,
          scope_alignment_score_threshold: 0.25,
          grounded_threshold: 0.75,
          partially_grounded_threshold: 0.5,
          service_status: "normal",
          service_message: null,
          updated_by: null,
          updated_at: null,
        };

        response.statusCode = 200;
        response.body = JSON.stringify(rows[0] ?? fallback);
        break;
      }

      // fetches the list of users for admin to view
      case "GET /admin/users": {
        try {
          const qs = event.queryStringParameters ?? {};
          const limit = Math.min(parseInt(qs.limit ?? "50", 10), 100); // cap limit to 100
          const offset = parseInt(qs.offset ?? "0", 10);

          const rows = await sqlConnection`
            SELECT id, email, display_name, role, created_at, last_seen_at
            FROM users
            ORDER BY COALESCE(last_seen_at, created_at) DESC
            LIMIT ${limit} OFFSET ${offset}
          `;

          response.statusCode = 200;
          response.body = JSON.stringify(rows);
          break;
        } catch (err) {
          console.error("GET /admin/users error:", errorSummary(err));
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // fetches the chat sessions for a specific user 
      case "GET /admin/users/{userId}/chat_sessions": {
        try {
          const userId = event.pathParameters?.userId;
          if (!userId) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "User ID is required" });
            break;
          }

          const qs = event.queryStringParameters ?? {};
          const limit = parseInt(qs.limit ?? "50", 10);
          const offset = parseInt(qs.offset ?? "0", 10);

          const rows = await sqlConnection`
            SELECT id, user_id, title, created_at, last_active_at
            FROM chat_sessions
            WHERE user_id = ${userId}
            ORDER BY COALESCE(last_active_at, created_at) DESC
            LIMIT ${limit} OFFSET ${offset}
          `;

          response.statusCode = 200;
          response.body = JSON.stringify(rows);
          break;
        } catch (err) {
          console.error("GET /admin/users/{userId}/chat_sessions error:", errorSummary(err));
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // fetches the messages for a specific chat session
      case "GET /admin/chat_sessions/{sessionId}/messages": {
        try {
          const sessionId = event.pathParameters?.sessionId;
          if (!sessionId) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "Session ID is required" });
            break;
          }

          const qs = event.queryStringParameters ?? {};
          const limit = parseInt(qs.limit ?? "200", 10);
          const offset = parseInt(qs.offset ?? "0", 10);

          const rows = await sqlConnection`
             SELECT id, chat_session_id, sender, content, sources, created_at
             FROM chat_messages
             WHERE chat_session_id = ${sessionId}
             ORDER BY created_at ASC
             LIMIT ${limit} OFFSET ${offset}
          `;

          response.statusCode = 200;
          response.body = JSON.stringify(rows);
          break;
        } catch (err) {
          console.error("GET /admin/chat_sessions/{sessionId}/messages error:", errorSummary(err));
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // Update settings (patch-style)
      case "PUT /admin/system-settings": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const validateOptionalUnitIntervalField = (obj, fieldName) => {
          const value = obj[fieldName];

          if (value === undefined) return null;

          if (!isFiniteNumber(value) || value < 0 || value > 1) {
            return `${fieldName} must be a number between 0 and 1`;
          }

          return null;
        };

        const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
        const isFiniteInt = (v) => Number.isInteger(v) && Number.isFinite(v);

        const allowed = [
          "max_messages_per_day",
          "min_messages_before_suggest",
          "routing_mode",
          "min_exchanges_before_answer",
          "max_characters_per_user_message",
          "max_characters_per_day",
          "max_messages_per_day_global",
          "max_characters_per_ai_message",
          "temperature",
          "top_p",
          "support_score_threshold",
          "scope_alignment_score_threshold",
          "grounded_threshold",
          "partially_grounded_threshold",
          "service_status",
          "service_message",
        ];

        const patch = {};
        for (const key of allowed) {
          if (body[key] !== undefined) patch[key] = body[key];
        }

        if (Object.keys(patch).length === 0) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "No valid fields to update" });
          break;
        }

        // validate user (Cognito sub from the admin authorizer)
        if (!adminSubFromEvent(event)) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        if (
          patch.max_messages_per_day !== undefined &&
          (!isFiniteInt(patch.max_messages_per_day) ||
            patch.max_messages_per_day < 1 ||
            patch.max_messages_per_day > 1000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_messages_per_day must be an integer between 1 and 1000",
          });
          break;
        }

        if (
          patch.min_messages_before_suggest !== undefined &&
          (!isFiniteInt(patch.min_messages_before_suggest) ||
            patch.min_messages_before_suggest < 0 ||
            patch.min_messages_before_suggest > 500)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "min_messages_before_suggest must be an integer between 0 and 500",
          });
          break;
        }

        if (
          patch.routing_mode !== undefined &&
          !["fixed", "dynamic"].includes(patch.routing_mode)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "routing_mode must be 'fixed' or 'dynamic'",
          });
          break;
        }

        if (
          patch.min_exchanges_before_answer !== undefined &&
          (!isFiniteInt(patch.min_exchanges_before_answer) ||
            patch.min_exchanges_before_answer < 0 ||
            patch.min_exchanges_before_answer > 500)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "min_exchanges_before_answer must be an integer between 0 and 500",
          });
          break;
        }

        if (
          patch.max_characters_per_user_message !== undefined &&
          (!isFiniteInt(patch.max_characters_per_user_message) ||
            patch.max_characters_per_user_message < 1 ||
            patch.max_characters_per_user_message > 200000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_characters_per_user_message must be a positive integer",
          });
          break;
        }

        if (
          patch.max_characters_per_day !== undefined &&
          (!isFiniteInt(patch.max_characters_per_day) ||
            patch.max_characters_per_day < 1 ||
            patch.max_characters_per_day > 1000000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_characters_per_day must be an integer between 1 and 1000000",
          });
          break;
        }

        if (
          patch.max_messages_per_day_global !== undefined &&
          (!isFiniteInt(patch.max_messages_per_day_global) ||
            patch.max_messages_per_day_global < 1 ||
            patch.max_messages_per_day_global > 1000000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_messages_per_day_global must be an integer between 1 and 1000000",
          });
          break;
        }

        if (
          patch.max_characters_per_ai_message !== undefined &&
          (!isFiniteInt(patch.max_characters_per_ai_message) ||
            patch.max_characters_per_ai_message < 1 ||
            patch.max_characters_per_ai_message > 200000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_characters_per_ai_message must be a positive integer",
          });
          break;
        }

        if (
          patch.temperature !== undefined &&
          (!isFiniteNumber(patch.temperature) ||
            patch.temperature < 0 ||
            patch.temperature > 2)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "temperature must be a number between 0 and 2",
          });
          break;
        }

        const unitIntervalFields = [
          "top_p",
          "support_score_threshold",
          "scope_alignment_score_threshold",
          "grounded_threshold",
          "partially_grounded_threshold",
        ];

        let unitIntervalError = null;

        for (const field of unitIntervalFields) {
          unitIntervalError = validateOptionalUnitIntervalField(patch, field);
          if (unitIntervalError) break;
        }

        if (unitIntervalError) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: unitIntervalError });
          break;
        }

        // Service status (maintenance banner / read-only). service_message may be
        // cleared explicitly with null or an empty string; leaving it out keeps it.
        const SERVICE_STATUSES = ["normal", "banner", "read_only"];
        const SERVICE_MESSAGE_MAX = 500;
        const serviceMessageProvided = patch.service_message !== undefined;

        if (
          patch.service_status !== undefined &&
          !SERVICE_STATUSES.includes(patch.service_status)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "service_status must be 'normal', 'banner' or 'read_only'",
          });
          break;
        }

        if (serviceMessageProvided) {
          if (patch.service_message !== null && typeof patch.service_message !== "string") {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "service_message must be text or null" });
            break;
          }
          // Control characters (including line breaks) become spaces; one line of text.
          const cleaned =
            patch.service_message === null
              ? ""
              : patch.service_message
                  .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
                  .replace(/\s+/g, " ")
                  .trim();
          if (cleaned.length > SERVICE_MESSAGE_MAX) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: `service_message must be at most ${SERVICE_MESSAGE_MAX} characters`,
            });
            break;
          }
          patch.service_message = cleaned === "" ? null : cleaned;
        }

        // get admin user ID by Cognito sub and confirm role
        const admin = await resolveAdminUser(sqlConnection, event);
        if (admin.error) {
          response.statusCode = admin.statusCode;
          response.body = JSON.stringify({ error: admin.error });
          break;
        }

        const updatedByUserId = admin.id;

        // A banner or read-only mode needs something to show. Judge the result of the
        // patch, so setting the status alone works when a message is already stored and
        // clearing the message alone is refused while the status still needs one.
        if (patch.service_status !== undefined || serviceMessageProvided) {
          const currentStatusRows = await sqlConnection`
            SELECT service_status, service_message
            FROM system_settings
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
          `;
          const currentStatus = currentStatusRows[0] ?? {};
          const nextStatus = patch.service_status ?? currentStatus.service_status ?? "normal";
          const nextMessage = serviceMessageProvided
            ? patch.service_message
            : currentStatus.service_message ?? null;
          if (nextStatus !== "normal" && !nextMessage) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "service_message is required when service_status is 'banner' or 'read_only'",
            });
            break;
          }
        }

        // The dynamic-routing floor may not exceed the ceiling. Compare against
        // stored values for whichever side is not in this patch.
        if (
          patch.min_exchanges_before_answer !== undefined ||
          patch.min_messages_before_suggest !== undefined
        ) {
          const currentRows = await sqlConnection`
            SELECT min_messages_before_suggest, min_exchanges_before_answer
            FROM system_settings
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
          `;
          const current = currentRows[0] ?? {};
          const floor =
            patch.min_exchanges_before_answer ?? current.min_exchanges_before_answer ?? 0;
          const ceiling =
            patch.min_messages_before_suggest ?? current.min_messages_before_suggest ?? 4;
          if (floor > ceiling) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error:
                "min_exchanges_before_answer must be less than or equal to min_messages_before_suggest",
            });
            break;
          }
        }

        // Single UPDATE of the latest row (no â€œensure row existsâ€ step)
        // Runs in one transaction with its audit row (field names only, no values).
        let settingsAudit = null;
        const updated = await sqlConnection.begin(async (tx) => {
          const rows = await tx`
          WITH latest AS (
            SELECT id
            FROM system_settings
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
          )
          UPDATE system_settings s
          SET
            max_messages_per_day = COALESCE(${patch.max_messages_per_day ?? null}::int, s.max_messages_per_day),
            min_messages_before_suggest = COALESCE(${patch.min_messages_before_suggest ?? null}::int, s.min_messages_before_suggest),
            routing_mode = COALESCE(${patch.routing_mode ?? null}::varchar, s.routing_mode),
            min_exchanges_before_answer = COALESCE(${patch.min_exchanges_before_answer ?? null}::int, s.min_exchanges_before_answer),
            max_characters_per_user_message = COALESCE(${patch.max_characters_per_user_message ?? null}::int, s.max_characters_per_user_message),
            max_characters_per_day = COALESCE(${patch.max_characters_per_day ?? null}::int, s.max_characters_per_day),
            max_messages_per_day_global = COALESCE(${patch.max_messages_per_day_global ?? null}::int, s.max_messages_per_day_global),
            max_characters_per_ai_message = COALESCE(${patch.max_characters_per_ai_message ?? null}::int, s.max_characters_per_ai_message),
            temperature = COALESCE(${patch.temperature ?? null}::float8, s.temperature),
            top_p = COALESCE(${patch.top_p ?? null}::float8, s.top_p),
            support_score_threshold = COALESCE(${patch.support_score_threshold ?? null}::float8, s.support_score_threshold),
            scope_alignment_score_threshold = COALESCE(${patch.scope_alignment_score_threshold ?? null}::float8, s.scope_alignment_score_threshold),
            grounded_threshold = COALESCE(${patch.grounded_threshold ?? null}::float8, s.grounded_threshold),
            partially_grounded_threshold = COALESCE(${patch.partially_grounded_threshold ?? null}::float8, s.partially_grounded_threshold),
            service_status = COALESCE(${patch.service_status ?? null}::varchar, s.service_status),
            service_message = CASE WHEN ${serviceMessageProvided}::boolean THEN ${patch.service_message ?? null}::text ELSE s.service_message END,
            updated_by = ${updatedByUserId},
            updated_at = NOW()
          WHERE s.id = (SELECT id FROM latest)
          RETURNING
            s.id,
            s.max_messages_per_day,
            s.min_messages_before_suggest,
            s.routing_mode,
            s.min_exchanges_before_answer,
            s.max_characters_per_user_message,
            s.max_characters_per_day,
            s.max_messages_per_day_global,
            s.max_characters_per_ai_message,
            s.temperature,
            s.top_p,
            s.support_score_threshold,
            s.scope_alignment_score_threshold,
            s.grounded_threshold,
            s.partially_grounded_threshold,
            s.service_status,
            s.service_message,
            s.updated_by,
            s.updated_at
        `;
          if (rows.length > 0) {
            settingsAudit = auditEntry(event, "system_settings.update", {
              settings_id: rows[0].id,
              fields: Object.keys(patch),
            });
            await insertAdminAudit(tx, settingsAudit);
          }
          return rows;
        });
        if (settingsAudit) logAdminAudit(settingsAudit);

        if (updated.length === 0) {
          // Should never happen because we seed system_settings
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "system_settings row not found (seed may not have run)",
          });
          break;
        }

        response.statusCode = 200;
        response.body = JSON.stringify(updated[0]);
        break;
      }

        break;

      // Handle unsupported routes
      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    // Handle specific PostgreSQL error codes
    if (error.code === "23505") {
      // Unique constraint violation (duplicate email)
      response.statusCode = 409; // Conflict
      response.body = JSON.stringify({ error: "Email already exists" });
    } else if (error.code === "23502") {
      // Not null constraint violation
      response.statusCode = 400; // Bad Request
      response.body = JSON.stringify({ error: "Required field is missing" });
    } else {
      // Generic server error for other exceptions
      handleError(error, response);
    }
  }

  return logAndReturn(event, response);
};

// Log a status line, then return the response to API Gateway. Admin responses
// hold user emails, chat transcripts, raw sources and feedback comments, so
// every route logs status only; no route logs its body. The status line names
// the acting admin (Cognito sub from the authorizer) so every admin action,
// including a denied one, is attributable (finding f-7f03f151).
function logAndReturn(event, response) {
  logResponse(event, response, { actorSub: adminSubFromEvent(event) });
  return response;
}
