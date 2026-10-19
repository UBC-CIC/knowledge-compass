/**
 * 041_user_email_normalized.js
 *
 * One canonical form for users.email (finding
 * f-3e4760da-63db-4015-9b79-5488e195ba5c). The column was UNIQUE on exact
 * bytes (000_initial_schema: email varchar UNIQUE) while some writers stored
 * the address as supplied and some readers compared lower(email). A mixed-case
 * row and its lowercase twin could both exist, and a case-insensitive lookup
 * could see both.
 *
 * Changes:
 *   1. Fold existing addresses: trim, lowercase, and keep a single row per
 *      folded value. The keeper prefers role 'admin', then identity_source
 *      'cognito', then a row that already has a cognito_sub, then the earliest
 *      created_at, then the smallest id. Every other row in the group has its
 *      email set to NULL (the same detach staff sign-in already does). Blank
 *      addresses become NULL. This folding is not reversed by down.
 *   2. Drop the case-sensitive UNIQUE (users_email_key, or any other
 *      single-column unique constraint on users.email).
 *   3. CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email)).
 *      Multiple NULLs stay allowed. ON CONFLICT (email) is not used anymore
 *      (staff identity is keyed on cognito_sub); a conflict is still error
 *      23505, which PUT /user and POST /admin/users already map to 409.
 *   4. CHECK users_email_lowercase_check: a stored email is NULL or already
 *      equal to lower(btrim(email)), so a writer that skips normalisation
 *      fails closed instead of inserting a case variant.
 */

exports.up = (pgm) => {
  pgm.sql(`
    WITH ranked AS (
      SELECT
        id,
        lower(btrim(email)) AS folded,
        row_number() OVER (
          PARTITION BY lower(btrim(email))
          ORDER BY
            (role = 'admin'::user_role) DESC,
            (identity_source = 'cognito') DESC,
            (cognito_sub IS NOT NULL) DESC,
            created_at ASC NULLS LAST,
            id ASC
        ) AS rn
      FROM users
      WHERE email IS NOT NULL AND btrim(email) <> ''
    )
    UPDATE users u
       SET email = CASE WHEN r.rn = 1 THEN r.folded ELSE NULL END
      FROM ranked r
     WHERE u.id = r.id
       AND u.email IS DISTINCT FROM CASE WHEN r.rn = 1 THEN r.folded ELSE NULL END;

    UPDATE users
       SET email = NULL
     WHERE email IS NOT NULL AND btrim(email) = '';

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

    DO $$
    DECLARE
      cons name;
    BEGIN
      FOR cons IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = current_schema()
           AND t.relname = 'users'
           AND c.contype = 'u'
           AND c.conkey = (
             SELECT ARRAY[a.attnum]::smallint[]
               FROM pg_attribute a
              WHERE a.attrelid = c.conrelid
                AND a.attname = 'email'
                AND NOT a.attisdropped
           )
      LOOP
        EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', cons);
      END LOOP;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

    DO $$ BEGIN
      ALTER TABLE users
        ADD CONSTRAINT users_email_lowercase_check
        CHECK (email IS NULL OR email = lower(btrim(email)));
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
};

exports.down = (pgm) => {
  // Folded values and emails nulled to break a case collision stay as they
  // are. Restoring the original bytes could recreate the collision.
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_lowercase_check;
    DROP INDEX IF EXISTS users_email_lower_key;

    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;
  `);
};
