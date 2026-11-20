/**
 * Evaluation-harness session tags (evals/, migration 035).
 *
 * The harness creates sessions with a top-level `eval` field on
 * POST /chat_sessions:
 *
 *   eval: { run_id, mode, exp, sig }
 *   sig  = hex(HMAC-SHA256(signingKey, `${userId}.${run_id}.${mode}.${exp}`))
 *
 * userId is the caller's id from the verified token, so a tag signed for one
 * anonymous user cannot be replayed by another. The signing key lives in
 * Secrets Manager (EVAL_SIGNING_SECRET_NAME, JSON {"signingKey": "...",
 * "previousSigningKey": "..."}), created by the optional EvalStack and rotated
 * by appSecretRotation; tags verify against either key.
 *
 * Fails closed: a missing env var, an unreadable secret, or any invalid field
 * means "no tag" and the session is created as a normal one. Callers never
 * learn why verification failed, and neither the tag nor the key is logged.
 */

const crypto = require("crypto");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SIG_PATTERN = /^[0-9a-f]{64}$/;
const EVAL_MODES = ["standard", "guideline"];
const MAX_TAG_LIFETIME_SECONDS = 24 * 60 * 60;
const SECRET_TTL_MS = 5 * 60 * 1000;

let secretsClient;
let cachedKeys = [];
let cachedAt = 0;

/** Signing payload; shared with evals/harness/signing.py. */
const signingPayload = (userId, runId, mode, exp) => `${userId}.${runId}.${mode}.${exp}`;

const sign = (key, userId, runId, mode, exp) =>
  crypto.createHmac("sha256", key).update(signingPayload(userId, runId, mode, exp)).digest("hex");

/**
 * Pure check of a tag against `key` for `userId` at `nowSeconds`.
 * Returns { runId, mode } when valid, otherwise null.
 */
function verifyEvalTag(tag, userId, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!key || typeof key !== "string") return null;
  if (!userId || typeof userId !== "string") return null;
  if (!tag || typeof tag !== "object" || Array.isArray(tag)) return null;

  const { run_id: runId, mode, exp, sig } = tag;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return null;
  if (typeof mode !== "string" || !EVAL_MODES.includes(mode)) return null;
  if (!Number.isInteger(exp)) return null;
  if (exp <= nowSeconds || exp > nowSeconds + MAX_TAG_LIFETIME_SECONDS) return null;
  if (typeof sig !== "string" || !SIG_PATTERN.test(sig)) return null;

  const expected = Buffer.from(sign(key, userId, runId, mode, exp), "hex");
  const given = Buffer.from(sig, "hex");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  return { runId, mode };
}

/** Field formats only (no HMAC); verifyEvalTag repeats these checks. */
function hasTagShape(tag) {
  if (!tag || typeof tag !== "object" || Array.isArray(tag)) return false;
  const { run_id: runId, mode, exp, sig } = tag;
  return (
    typeof runId === "string" && RUN_ID_PATTERN.test(runId)
    && typeof mode === "string" && EVAL_MODES.includes(mode)
    && Number.isInteger(exp)
    && typeof sig === "string" && SIG_PATTERN.test(sig)
  );
}

/**
 * Current and previous signing keys from Secrets Manager, cached per
 * container. appSecretRotation keeps the outgoing key as previousSigningKey,
 * so tags signed just before a rotation still verify. [] = not configured.
 */
async function getSigningKeys() {
  const secretName = process.env.EVAL_SIGNING_SECRET_NAME;
  if (!secretName) return [];
  // Gate on the fetch time, not the value, so "no usable key" is cached too;
  // otherwise every request with an eval field would hit Secrets Manager.
  if (cachedAt && Date.now() - cachedAt < SECRET_TTL_MS) return cachedKeys;
  try {
    secretsClient = secretsClient || new SecretsManagerClient();
    const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    const parsed = JSON.parse(result.SecretString || "{}");
    cachedKeys = [parsed.signingKey, parsed.previousSigningKey].filter(
      (key) => typeof key === "string" && key.length >= 32
    );
    cachedAt = Date.now();
    return cachedKeys;
  } catch (error) {
    // Expected when the EvalStack is not deployed. Name only; no secret detail.
    console.warn("Eval signing key unavailable:", error?.name || "Error");
    cachedKeys = [];
    cachedAt = Date.now();
    return [];
  }
}

/**
 * Resolve the eval tag on a POST /chat_sessions body for `userId`.
 * Returns { runId, mode } or null. Never throws.
 */
async function resolveEvalTag(body, userId) {
  const tag = body && typeof body === "object" ? body.eval : undefined;
  if (tag === undefined || tag === null) return null;
  // Reject malformed tags before any secret lookup, so junk input costs nothing.
  if (!hasTagShape(tag)) return null;
  try {
    for (const key of await getSigningKeys()) {
      const verified = verifyEvalTag(tag, userId, key);
      if (verified) return verified;
    }
    return null;
  } catch {
    return null;
  }
}

/** Test hook: clear the cached keys. */
function resetEvalTagCache() {
  cachedKeys = [];
  cachedAt = 0;
  secretsClient = undefined;
}

module.exports = {
  EVAL_MODES,
  MAX_TAG_LIFETIME_SECONDS,
  signingPayload,
  sign,
  verifyEvalTag,
  resolveEvalTag,
  resetEvalTagCache,
};
