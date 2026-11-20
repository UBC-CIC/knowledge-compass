/**
 * 046_guest_email_cleared.js
 *
 * Guests hold no email address (finding F16 / M3). PUT /user/{user_id}, the
 * only route that let a guest write users.email, is removed in the same
 * change, and POST /user never reads one.
 *
 * Changes:
 *   1. Clear email on guest student rows (identity_source 'guest', role
 *      'student'): every value there was typed by an anonymous caller through
 *      PUT /user. Rows with role 'admin' are left alone: POST /admin/users
 *      inserts without identity_source, so its rows default to 'guest' while
 *      carrying an administrator-supplied address. Not reversed by down.
 *   2. CHECK users_guest_student_email_null: a guest student row cannot hold
 *      an email, so a future writer that sets one fails closed. Staff writers
 *      (authorization/staffIdentity.js, knowledgeBase/helpers/admin_user.py)
 *      only set email on rows with a cognito_sub, which migration 039 limits
 *      to 'cognito' rows; their detach path only sets email to NULL.
 */

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE users
       SET email = NULL
     WHERE identity_source = 'guest'
       AND role = 'student'::user_role
       AND email IS NOT NULL;

    DO $$ BEGIN
      ALTER TABLE users
        ADD CONSTRAINT users_guest_student_email_null
        CHECK (identity_source <> 'guest' OR role <> 'student'::user_role OR email IS NULL);
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
};

exports.down = (pgm) => {
  // Cleared addresses are not restored.
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_guest_student_email_null;
  `);
};
