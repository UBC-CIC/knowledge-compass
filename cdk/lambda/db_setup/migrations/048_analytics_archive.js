/**
 * 048_analytics_archive.js
 *
 * Anonymous activity counts kept when the retention job
 * (handlers/retentionHandler.js) deletes an inactive guest (finding F19 / M7,
 * decision D12: a guest and all their chats are deleted 90 days after their
 * last activity). Admin analytics (GET /admin/analytics) adds these rows to
 * the live tables, so totals and time series do not drop as data ages out.
 *
 * Changes:
 *   1. analytics_archive: one row per (archive_user_id, activity_date) with
 *      only counts: sessions created, messages, user questions, thumbs up and
 *      thumbs down on that day. archive_user_id is a fresh number from
 *      analytics_archive_user_seq, drawn when the guest is deleted; it is not
 *      derived from and cannot be joined back to users.id. It exists so
 *      distinct-user counts stay exact over any date range. No message text,
 *      feedback text, titles, metadata or user ids are kept. Evaluation
 *      sessions (eval_run_id set) are never archived.
 *   2. readwrite gets DML on the table and USAGE on the sequence when the role
 *      already exists (on a new database createAppUsers grants it after
 *      migrations).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE SEQUENCE IF NOT EXISTS analytics_archive_user_seq AS bigint;

    CREATE TABLE IF NOT EXISTS analytics_archive (
      archive_user_id   bigint      NOT NULL,
      activity_date     date        NOT NULL,
      sessions_created  integer     NOT NULL DEFAULT 0 CHECK (sessions_created >= 0),
      messages          integer     NOT NULL DEFAULT 0 CHECK (messages >= 0),
      questions         integer     NOT NULL DEFAULT 0 CHECK (questions >= 0),
      thumbs_up         integer     NOT NULL DEFAULT 0 CHECK (thumbs_up >= 0),
      thumbs_down       integer     NOT NULL DEFAULT 0 CHECK (thumbs_down >= 0),
      archived_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (archive_user_id, activity_date)
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_archive_activity_date
      ON analytics_archive (activity_date);

    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readwrite') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_archive TO readwrite;
        GRANT USAGE ON SEQUENCE analytics_archive_user_seq TO readwrite;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS analytics_archive;
    DROP SEQUENCE IF EXISTS analytics_archive_user_seq;
  `);
};
