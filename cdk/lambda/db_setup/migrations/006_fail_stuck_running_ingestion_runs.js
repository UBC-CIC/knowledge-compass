/**
 * 006_fail_stuck_running_ingestion_runs.js
 *
 * One-time cleanup: before handle_ecs_task_stopped (process_crawler_batch.py)
 * existed, an ECS crawler/transcriber task that crashed without reaching the
 * DB left its ingestion_runs row stuck in 'running' forever. That gap is now
 * closed going forward, so this only needs to fix the rows already stuck from
 * before the fix shipped.
 *
 * Safe to run once: any run still 'running' at migration time has no ECS task
 * left to finalize it (the fix above now does that for every run started
 * after this migration), so there is nothing left to "wait" for.
 */

exports.up = async (pgm) => {
  await pgm.sql(`
    UPDATE ingestion_runs
    SET status = 'failed'::ingestion_status,
        error_message = COALESCE(error_message, 'Marked failed by one-time cleanup: run was stuck in running with no active task.'),
        completed_at = COALESCE(completed_at, now()),
        finished_at = COALESCE(finished_at, now())
    WHERE status = 'running'::ingestion_status;
  `);
};

exports.down = () => {
  // Not reversible — the original "stuck running" state is not recoverable.
};
