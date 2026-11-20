/**
 * Validation for client-supplied chat_sessions.metadata (POST /chat_sessions).
 *
 * The generation pipeline reads server-authored keys out of this column and
 * places them in the model's system prompt (journey_state, guide_state) or
 * uses them for routing. Those keys are written only by the Python pipeline
 * (textGeneration/helpers/crud.py, direct SQL), so a client may never set them.
 *
 * Client-settable keys are allow-listed in CLIENT_METADATA_FIELDS with a type
 * and length budget. It is empty today: the callers checked
 * (frontend/src/pages/HomePage.tsx and evals/harness/client.py) send no
 * metadata. Add a key there, with its spec, before a client starts sending it.
 *
 * Error messages are fixed strings and never echo the caller's keys or values.
 */

const SERVER_AUTHORED_KEYS = Object.freeze(["journey_state", "guide_state", "routing"]);

// key -> { type: "string" | "number" | "boolean", maxLength?: number }
const CLIENT_METADATA_FIELDS = Object.freeze({});

const MAX_METADATA_BYTES = 2048;

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Validate `value` against the field specs `fields`. Exported for tests only
 * (so the type/size checks can be exercised with a non-empty spec); callers
 * use validateSessionMetadata.
 * Returns { valid: true, metadata } or { valid: false, error }.
 */
function _validateWith(value, fields) {
  if (value === undefined || value === null) return { valid: true, metadata: {} };
  if (!isPlainObject(value)) return { valid: false, error: "metadata must be an object" };

  const keys = Object.keys(value);
  if (keys.some((key) => SERVER_AUTHORED_KEYS.includes(key))) {
    return { valid: false, error: "metadata contains a server-managed key" };
  }
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(fields, key))) {
    return { valid: false, error: "metadata contains an unsupported key" };
  }

  const metadata = {};
  for (const key of keys) {
    const spec = fields[key];
    const fieldValue = value[key];
    if (typeof fieldValue !== spec.type) {
      return { valid: false, error: "metadata has an invalid value" };
    }
    if (spec.type === "string" && spec.maxLength !== undefined && fieldValue.length > spec.maxLength) {
      return { valid: false, error: "metadata has an invalid value" };
    }
    if (spec.type === "number" && !Number.isFinite(fieldValue)) {
      return { valid: false, error: "metadata has an invalid value" };
    }
    metadata[key] = fieldValue;
  }

  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
    return { valid: false, error: "metadata is too large" };
  }
  return { valid: true, metadata };
}

/** Validate client metadata for a new chat session. */
function validateSessionMetadata(value) {
  return _validateWith(value, CLIENT_METADATA_FIELDS);
}

module.exports = {
  validateSessionMetadata,
  SERVER_AUTHORED_KEYS,
  CLIENT_METADATA_FIELDS,
  MAX_METADATA_BYTES,
  _validateWith,
};
