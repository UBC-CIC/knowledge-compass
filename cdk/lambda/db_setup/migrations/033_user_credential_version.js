/**
 * 033_user_credential_version.js
 *
 * Makes anonymous users' credentials revocable. Each credential POST /user or
 * GET /user/publicToken signs carries the user's credential_version; the
 * exchange at GET /user/publicToken (handlers/utils/userCredential.js) only
 * accepts the current version (or the previous one for a short grace window
 * right after rotation, credential_rotated_at). Bumping the version revokes
 * every outstanding credential for that user.
 *
 * Existing rows start at version 0 with no rotation time. Credentials issued
 * before this migration carry no version and are rejected, so those browsers
 * start a new anonymous user.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS credential_version integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS credential_rotated_at timestamptz;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS credential_rotated_at,
      DROP COLUMN IF EXISTS credential_version;
  `);
};
