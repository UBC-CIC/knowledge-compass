/**
 * 033_embedding_jobs.js
 *
 * One table for every long-running embedding-space operation, so the admin UI
 * polls a single endpoint and a crashed Lambda can resume from persisted state:
 *
 *   dry_run   count what a rebuild would embed and estimate tokens / cost / time
 *   rebuild   embed every chunk that has no current vector in the space
 *   delta     the same loop, restricted to what is still missing or stale
 *   validate  coverage, per-source-type counts and golden-set quality
 *   activate  lock -> wait_idle -> delta -> revalidate -> flip -> post_flip_check -> unlock
 *   rollback  the same steps, flipping back to a retired space
 *
 * `cursor` is the last chunk id a rebuild/delta batch finished (chunks are scanned in
 * id order), `continuation` counts self-invocations, `steps` / `current_step` carry
 * the activate/rollback progress, and `report` holds the dry-run estimate details or
 * the validation report. The report never contains chunk text.
 *
 * Two partial unique indexes enforce the concurrency rules in the database, not just
 * in code: at most one queued/running rebuild|delta job per space, and at most one
 * queued/running activate|rollback job at all (there is a single active pointer).
 *
 * price_configured is false when the space has no price_per_1m_tokens; the API and UI
 * then show "price not configured" instead of a cost.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS embedding_jobs (
      id                uuid           PRIMARY KEY DEFAULT uuid_generate_v4(),
      space_id          uuid           NOT NULL REFERENCES embedding_spaces(id),
      mode              varchar(16)    NOT NULL
                                       CHECK (mode IN ('dry_run', 'rebuild', 'delta', 'validate', 'activate', 'rollback')),
      status            varchar(16)    NOT NULL DEFAULT 'queued'
                                       CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      total_chunks      integer        NULL,
      processed         integer        NOT NULL DEFAULT 0,
      failed            integer        NOT NULL DEFAULT 0,
      est_tokens        bigint         NULL,
      est_cost_usd      numeric(14,4)  NULL,
      est_seconds       integer        NULL,
      price_configured  boolean        NOT NULL DEFAULT false,
      cursor            text           NULL,
      continuation      integer        NOT NULL DEFAULT 0,
      current_step      varchar(32)    NULL,
      steps             jsonb          NOT NULL DEFAULT '[]',
      report            jsonb          NULL,
      last_error        text           NULL,
      requested_by      varchar(320),
      created_at        timestamptz    NOT NULL DEFAULT now(),
      started_at        timestamptz    NULL,
      finished_at       timestamptz    NULL,
      updated_at        timestamptz    NOT NULL DEFAULT now()
    );

    -- One queued/running rebuild or delta per space.
    CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_one_active_rebuild
      ON embedding_jobs (space_id)
      WHERE mode IN ('rebuild', 'delta') AND status IN ('queued', 'running');

    -- One queued/running cutover (activate or rollback) in total.
    CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_one_active_cutover
      ON embedding_jobs ((1))
      WHERE mode IN ('activate', 'rollback') AND status IN ('queued', 'running');

    CREATE INDEX IF NOT EXISTS embedding_jobs_space_created_idx
      ON embedding_jobs (space_id, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS embedding_jobs;
  `);
};
