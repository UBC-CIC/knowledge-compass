/**
 * 039_user_identity_source.js
 *
 * Separate guest identities from staff identities (finding
 * f-23c5bf7c-c3ba-4a4c-a77b-996f84c30740). users.email was the only key that
 * resolved an administrator, and anonymous callers can write it (POST /user,
 * PUT /user/{user_id}), so a guest could pre-claim a staff address and own
 * the row every admin-role gate and audit lookup resolved to.
 *
 * Changes:
 *   1. users.identity_source ('guest' | 'cognito', NOT NULL, default 'guest').
 *      Every insert that does not say otherwise (POST /user, older code during
 *      a rollback) is a guest. Nothing in the guest API can change it.
 *   2. users.cognito_sub (UNIQUE, only allowed on 'cognito' rows). Admin
 *      identity is resolved by the Cognito sub from the admin authorizer
 *      (requestContext.authorizer.userId), never by email. See
 *      authorization/staffIdentity.js and knowledgeBase/helpers/admin_user.py.
 *   3. Backfill: a row is 'cognito' only if role = 'admin', it has an email
 *      and it owns no chat_sessions (real admin rows are created by the
 *      PostConfirmation trigger / promote_user / ingestion and never own
 *      public chats, which always run under a POST /user guest row).
 *      Everything else is 'guest'. These legacy 'cognito' rows have no sub
 *      yet; each is linked once, by email, on the admin's next sign-in or
 *      admin request. A guest row is never linked.
 *   4. credential_version is bumped on every 'cognito' row, revoking any
 *      guest credential an anonymous party held for a squatted row before it
 *      can become an admin's identity (userCredential.js also refuses to
 *      exchange credentials for non-guest rows).
 *
 * UNIQUE(email) is kept so PUT /user's 409 contract and older code's
 * ON CONFLICT (email) keep working during a rollback.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS identity_source varchar(16),
      ADD COLUMN IF NOT EXISTS cognito_sub varchar(128);

    UPDATE users u
       SET identity_source = 'cognito'
     WHERE u.identity_source IS NULL
       AND u.role = 'admin'::user_role
       AND u.email IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.user_id = u.id);

    UPDATE users
       SET identity_source = 'guest'
     WHERE identity_source IS NULL;

    UPDATE users
       SET credential_version = credential_version + 1,
           credential_rotated_at = NULL
     WHERE identity_source = 'cognito';

    ALTER TABLE users
      ALTER COLUMN identity_source SET DEFAULT 'guest',
      ALTER COLUMN identity_source SET NOT NULL;

    DO $$ BEGIN
      ALTER TABLE users
        ADD CONSTRAINT users_identity_source_check
        CHECK (identity_source IN ('guest', 'cognito'));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
      ALTER TABLE users
        ADD CONSTRAINT users_cognito_sub_key UNIQUE (cognito_sub);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;

    DO $$ BEGIN
      ALTER TABLE users
        ADD CONSTRAINT users_cognito_sub_requires_cognito
        CHECK (cognito_sub IS NULL OR identity_source = 'cognito');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
};

exports.down = (pgm) => {
  // The credential_version bump is not reverted (harmless: affected
  // credentials simply stay revoked).
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_cognito_sub_requires_cognito;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_cognito_sub_key;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_identity_source_check;
    ALTER TABLE users
      DROP COLUMN IF EXISTS cognito_sub,
      DROP COLUMN IF EXISTS identity_source;
  `);
};
