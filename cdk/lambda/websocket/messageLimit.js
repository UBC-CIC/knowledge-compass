/**
 * Per-message character cap for the WebSocket frame path.
 *
 * system_settings.max_characters_per_user_message is the same setting
 * textGeneration enforces after config.load_config. This module is a separate
 * Lambda asset and cannot import the Python config, so the missed-load default
 * is repeated here and kept in sync (see frontend assistantSettings.test.ts).
 *
 * A missed read uses that default, or the last good value, and never a higher
 * stand-in. The result is cached on the warm container and refreshed on the
 * same interval as textGeneration's CONFIG_TTL_SECONDS.
 */

const postgres = require("postgres");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE = 2000;
// Code-level ceiling (textGeneration/helpers/config.py LIMIT_CEILINGS).
// adminHandler.js rejects saves above it, and a stored value above it is
// capped to it here, so a row written straight to the database cannot raise it.
const ABSOLUTE_MAX_CHARACTERS_PER_USER_MESSAGE = 4000;
const CACHE_TTL_MS = 300_000;
// Don't stall every frame on a down database; retry after this backoff.
const FAILURE_BACKOFF_MS = 30_000;

const secretsManager = new SecretsManagerClient();
let sqlConnection = null;
let cached = null; // { value, at }
let failedAt = null;

function parseCap(value) {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, ABSOLUTE_MAX_CHARACTERS_PER_USER_MESSAGE);
}

async function getSql() {
  if (sqlConnection) return sqlConnection;
  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: process.env.SM_DB_CREDENTIALS })
  );
  const credentials = JSON.parse(response.SecretString);
  const sql = postgres({
    host: process.env.RDS_PROXY_ENDPOINT,
    port: credentials.port,
    username: credentials.username,
    password: credentials.password,
    database: credentials.dbname,
    ssl: { rejectUnauthorized: true },
    connect_timeout: 3,
    max: 1,
  });
  try {
    await sql`SELECT 1`;
  } catch (err) {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      // The failed client is discarded either way.
    }
    throw err;
  }
  sqlConnection = sql;
  return sql;
}

async function readCapFromDb() {
  if (!process.env.SM_DB_CREDENTIALS || !process.env.RDS_PROXY_ENDPOINT) {
    throw new Error("database is not configured");
  }
  const sql = await getSql();
  const rows = await sql`
    SELECT max_characters_per_user_message
    FROM system_settings
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `;
  return parseCap(rows[0]?.max_characters_per_user_message);
}

/**
 * The cap to apply to this frame. `now` is injectable so tests can expire the cache.
 */
async function getMaxCharactersPerUserMessage(now = Date.now()) {
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  if (failedAt !== null && now - failedAt < FAILURE_BACKOFF_MS) {
    return cached ? cached.value : DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE;
  }
  try {
    const value = await readCapFromDb();
    if (value != null) {
      cached = { value, at: now };
      failedAt = null;
      return value;
    }
  } catch (err) {
    // Name only: postgres and Secrets Manager errors can echo the query or the secret id.
    console.error("max_characters_per_user_message read failed", { error: err?.name });
  }
  failedAt = now;
  return cached ? cached.value : DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE;
}

module.exports = {
  DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE,
  ABSOLUTE_MAX_CHARACTERS_PER_USER_MESSAGE,
  CACHE_TTL_MS,
  FAILURE_BACKOFF_MS,
  getMaxCharactersPerUserMessage,
};
