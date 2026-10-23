/**
 * Daily retention job for anonymous (guest) data (finding F19 / M7, decision
 * D12). Run by an EventBridge schedule (cdk/lib/api-stack.ts), not by API
 * Gateway.
 *
 * A guest user and everything they own are deleted once their most recent
 * activity (user created, last seen, any session created or active) is more
 * than RETENTION_DAYS old. Whole users are deleted, never single sessions, so
 * each guest is either fully live or fully archived and the analytics rollup
 * below stays exact.
 *
 * Per batch, in one transaction:
 *   1. Lock up to BATCH_SIZE inactive guest student rows (SKIP LOCKED).
 *   2. Add their non-evaluation activity to analytics_archive (migration 048):
 *      counts per day under a fresh anonymous archive_user_id. No text, ids
 *      or metadata are copied.
 *   3. Delete their chat_messages, then chat_sessions (session_feedback
 *      cascades), then the users rows (user_daily_usage and
 *      user_inflight_generations cascade).
 *
 * Then prunes per-request and per-user daily limit bookkeeping that is only
 * needed for the current day (finding F22 / f-3d9a17a9).
 *
 * Logs counts only, never ids or content.
 */

const postgres = require("postgres");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { errorSummary } = require("./utils/logging.js");

const RETENTION_DAYS = 90;
const BATCH_SIZE = 200;
// Upper bound on batches per run, so a fault that keeps returning the same
// rows cannot spin until the timeout.
const MAX_BATCHES = 500;
// Do not start a batch with less than this much invocation time left.
const TIME_RESERVE_MS = 60_000;
// daily_usage_requests rows exist to make async retries idempotent (retries
// are off and events expire within 60 s); keep two days.
const USAGE_REQUEST_KEEP_DAYS = 2;
// user_daily_usage only enforces today's limits; keep a week.
const USER_DAILY_USAGE_KEEP_DAYS = 7;

let sqlConnection;
const secretsManager = new SecretsManagerClient();

const initConnection = async () => {
  if (!sqlConnection) {
    const secretResponse = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: process.env.SM_DB_CREDENTIALS })
    );
    const credentials = JSON.parse(secretResponse.SecretString);
    sqlConnection = postgres({
      host: process.env.RDS_PROXY_ENDPOINT,
      port: credentials.port,
      username: credentials.username,
      password: credentials.password,
      database: credentials.dbname,
      ssl: { rejectUnauthorized: true },
    });
    await sqlConnection`SELECT 1`;
  }
};

const affected = (result) => result?.count ?? 0;

/** Archive and delete one batch of inactive guests. Returns counts. */
async function retireBatch(tx) {
  const victims = await tx`
    SELECT u.id
    FROM users u
    WHERE u.identity_source = 'guest'
      AND u.role = 'student'::user_role
      AND GREATEST(
            u.created_at,
            u.last_seen_at,
            (SELECT max(GREATEST(cs.created_at, cs.last_active_at))
               FROM chat_sessions cs
              WHERE cs.user_id = u.id)
          ) < now() - make_interval(days => ${RETENTION_DAYS})
      AND NOT EXISTS (SELECT 1 FROM data_sources d WHERE d.created_by = u.id)
      AND NOT EXISTS (SELECT 1 FROM system_messages m WHERE m.created_by = u.id)
      AND NOT EXISTS (SELECT 1 FROM system_settings s WHERE s.updated_by = u.id)
    ORDER BY u.created_at
    LIMIT ${BATCH_SIZE}
    FOR UPDATE OF u SKIP LOCKED
  `;
  if (victims.length === 0) {
    return { found: 0, users: 0, sessions: 0, messages: 0, archiveRows: 0 };
  }
  const ids = victims.map((v) => v.id);

  // victims is materialized once (nextval is volatile), so each guest gets
  // exactly one archive_user_id. Days come from the same expressions admin
  // analytics groups by.
  const archived = await tx`
    WITH victims AS (
      SELECT v.user_id, nextval('analytics_archive_user_seq') AS archive_user_id
      FROM unnest(${ids}::uuid[]) AS v(user_id)
    ),
    sessions AS (
      SELECT cs.user_id, DATE_TRUNC('day', cs.created_at)::date AS day,
             COUNT(*)::int AS sessions_created
      FROM chat_sessions cs
      JOIN victims v ON v.user_id = cs.user_id
      WHERE cs.eval_run_id IS NULL
      GROUP BY 1, 2
    ),
    messages AS (
      SELECT cs.user_id, DATE_TRUNC('day', cm.created_at)::date AS day,
             COUNT(*)::int AS messages,
             COUNT(*) FILTER (WHERE cm.sender = 'user')::int AS questions
      FROM chat_messages cm
      JOIN chat_sessions cs ON cs.id = cm.chat_session_id
      JOIN victims v ON v.user_id = cs.user_id
      WHERE cs.eval_run_id IS NULL
      GROUP BY 1, 2
    ),
    feedback AS (
      SELECT cs.user_id, DATE_TRUNC('day', sf.updated_at)::date AS day,
             COUNT(*) FILTER (WHERE sf.rating = 'up')::int AS thumbs_up,
             COUNT(*) FILTER (WHERE sf.rating = 'down')::int AS thumbs_down
      FROM session_feedback sf
      JOIN chat_sessions cs ON cs.id = sf.chat_session_id
      JOIN victims v ON v.user_id = cs.user_id
      WHERE cs.eval_run_id IS NULL
      GROUP BY 1, 2
    ),
    days AS (
      SELECT user_id, day FROM sessions
      UNION SELECT user_id, day FROM messages
      UNION SELECT user_id, day FROM feedback
    )
    INSERT INTO analytics_archive (
      archive_user_id, activity_date, sessions_created, messages, questions,
      thumbs_up, thumbs_down
    )
    SELECT v.archive_user_id, d.day,
           COALESCE(s.sessions_created, 0), COALESCE(m.messages, 0),
           COALESCE(m.questions, 0), COALESCE(f.thumbs_up, 0),
           COALESCE(f.thumbs_down, 0)
    FROM days d
    JOIN victims v ON v.user_id = d.user_id
    LEFT JOIN sessions s ON s.user_id = d.user_id AND s.day = d.day
    LEFT JOIN messages m ON m.user_id = d.user_id AND m.day = d.day
    LEFT JOIN feedback f ON f.user_id = d.user_id AND f.day = d.day
    WHERE d.day IS NOT NULL
  `;

  const messages = await tx`
    DELETE FROM chat_messages
    WHERE chat_session_id IN (
      SELECT id FROM chat_sessions WHERE user_id = ANY(${ids}::uuid[])
    )
  `;
  const sessions = await tx`
    DELETE FROM chat_sessions WHERE user_id = ANY(${ids}::uuid[])
  `;
  const users = await tx`
    DELETE FROM users
    WHERE id = ANY(${ids}::uuid[])
      AND identity_source = 'guest'
      AND role = 'student'::user_role
  `;

  return {
    found: victims.length,
    users: affected(users),
    sessions: affected(sessions),
    messages: affected(messages),
    archiveRows: affected(archived),
  };
}

exports.handler = async (_event, context) => {
  const totals = { batches: 0, users: 0, sessions: 0, messages: 0, archiveRows: 0, stoppedEarly: false };
  try {
    await initConnection();

    while (totals.batches < MAX_BATCHES) {
      if (context?.getRemainingTimeInMillis && context.getRemainingTimeInMillis() < TIME_RESERVE_MS) {
        totals.stoppedEarly = true;
        break;
      }
      const batch = await sqlConnection.begin((tx) => retireBatch(tx));
      totals.batches += 1;
      totals.users += batch.users;
      totals.sessions += batch.sessions;
      totals.messages += batch.messages;
      totals.archiveRows += batch.archiveRows;
      // Last page, or nothing could be deleted (avoid re-reading the same rows).
      if (batch.found < BATCH_SIZE || batch.users === 0) break;
    }
    if (totals.batches >= MAX_BATCHES) totals.stoppedEarly = true;

    const usageRequests = await sqlConnection`
      DELETE FROM daily_usage_requests
      WHERE created_at < now() - make_interval(days => ${USAGE_REQUEST_KEEP_DAYS})
    `;
    const userDailyUsage = await sqlConnection`
      DELETE FROM user_daily_usage
      WHERE usage_date < (now() AT TIME ZONE 'UTC')::date - ${USER_DAILY_USAGE_KEEP_DAYS}::int
    `;
    totals.usageRequestsPruned = affected(usageRequests);
    totals.userDailyUsagePruned = affected(userDailyUsage);

    console.log(JSON.stringify({ job: "guest_retention", retentionDays: RETENTION_DAYS, ...totals }));
    return totals;
  } catch (error) {
    console.error(JSON.stringify({ job: "guest_retention", ...totals, error: errorSummary(error) }));
    throw error;
  }
};

exports.RETENTION_DAYS = RETENTION_DAYS;
exports.BATCH_SIZE = BATCH_SIZE;
