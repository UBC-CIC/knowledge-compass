/**
 * 040_admin_audit.js
 *
 * Application audit trail for privileged admin actions (finding
 * f-0d57a9d0-8f1c-499e-bf61-5e38917497dd). Role elevation, system-message and
 * system-settings changes and corpus deletion left no record of the acting
 * administrator, so they could not be reconstructed after the fact.
 *
 * Changes:
 *   1. admin_audit (actor_sub, actor_email, action, target jsonb, request_id,
 *      created_at). The actor always comes from the verified admin authorizer
 *      context (requestContext.authorizer.userId / .email), never from a
 *      request body, so actor_sub is NOT NULL. target holds ids and field
 *      names only, never prompt content or setting values. Writers:
 *      handlers/utils/adminAudit.js and knowledgeBase/helpers/admin_audit.py,
 *      in the same transaction as the change they record.
 *   2. Indexes on created_at and (actor_sub, created_at) for investigations.
 *   3. Append-only: a trigger rejects UPDATE, DELETE and TRUNCATE. The app
 *      role has DELETE on every table (db_setup/index.js createAppUsers
 *      re-grants DML on all tables after every migration run), so without it
 *      a compromised handler could erase its own trail. Purging old rows is a
 *      migration-owner task.
 *   4. readwrite gets SELECT, INSERT when the role already exists (on a new
 *      database createAppUsers grants it after migrations).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      actor_sub varchar(128) NOT NULL,
      actor_email varchar(320) NULL,
      action varchar(64) NOT NULL,
      target jsonb NOT NULL DEFAULT '{}'::jsonb,
      request_id varchar(128) NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS admin_audit_created_at_idx
      ON admin_audit (created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_audit_actor_sub_created_at_idx
      ON admin_audit (actor_sub, created_at DESC);

    CREATE OR REPLACE FUNCTION admin_audit_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'admin_audit is append-only';
    END $$;

    DROP TRIGGER IF EXISTS admin_audit_no_update_delete ON admin_audit;
    CREATE TRIGGER admin_audit_no_update_delete
      BEFORE UPDATE OR DELETE ON admin_audit
      FOR EACH ROW EXECUTE FUNCTION admin_audit_append_only();

    DROP TRIGGER IF EXISTS admin_audit_no_truncate ON admin_audit;
    CREATE TRIGGER admin_audit_no_truncate
      BEFORE TRUNCATE ON admin_audit
      FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_append_only();

    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readwrite') THEN
        GRANT SELECT, INSERT ON admin_audit TO readwrite;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  // Dropping the table drops its triggers (DROP TRIGGER ... ON a missing
  // table would fail, so the table goes first).
  pgm.sql(`
    DROP TABLE IF EXISTS admin_audit;
    DROP FUNCTION IF EXISTS admin_audit_append_only();
  `);
};
