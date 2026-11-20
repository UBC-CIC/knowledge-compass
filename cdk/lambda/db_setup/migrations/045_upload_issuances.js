/**
 * 045_upload_issuances.js
 *
 * Binds every staged upload to the administrator its presigned URL was issued
 * to (finding f-cedd2bee-bf23-4aa9-a17c-9597603d52c8). POST /admin/data_sources
 * (and /batch) take the uploaded object's bucket/key from the request body;
 * without this, one administrator could name another's upload, stage it, then
 * re-stage the same file name so the replace path deleted the other upload.
 *
 * Changes:
 *   1. upload_issuances (s3_bucket, s3_key) primary key, issued_to_sub (the
 *      Cognito sub from the admin authorizer, never the body), issued_at,
 *      expires_at (the window staging may claim it in) and consumed_at.
 *      Written by knowledgeBase/helpers/generate_presigned_url*.py; claimed
 *      once, in the staging transaction, by helpers/upload_issuance.py.
 *   2. Index on expires_at for the opportunistic purge of old rows done when
 *      new URLs are issued.
 *   3. readwrite gets DML when the role already exists (on a new database
 *      createAppUsers grants it after migrations).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS upload_issuances (
      s3_bucket varchar(255) NOT NULL,
      s3_key varchar(1024) NOT NULL,
      issued_to_sub varchar(128) NOT NULL,
      issued_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz NULL,
      PRIMARY KEY (s3_bucket, s3_key)
    );

    CREATE INDEX IF NOT EXISTS upload_issuances_expires_at_idx
      ON upload_issuances (expires_at);

    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readwrite') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON upload_issuances TO readwrite;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS upload_issuances;`);
};
