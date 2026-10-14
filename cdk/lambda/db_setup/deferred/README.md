# Deferred database changes

Files in this folder are **not migrations**. `db_setup/index.js` runs node-pg-migrate with
`dir: db_setup/migrations/` only, so nothing here is ever applied by a deploy, and no CDK
code refers to this folder.

## `NNN_drop_legacy_embedding_column.js`

Drops the legacy single-model storage that migration `032_embedding_spaces.js` kept for
rollout compatibility: the `chunks.embedding` column, its `idx_chunks_embedding_hnsw`
index, and the trigger and function that mirror writes into the legacy embedding space.

### Approval gate (all must be true before it is moved or run)

1. Tasks 5 and 6 (retrieval and writers read and write the active embedding space) are
   deployed **and verified in production**.
2. At least one full embedding-space cutover has been completed, or the owner has
   decided in writing that none is needed yet.
3. The rollback window is closed: the previous space has been kept for the retention
   period (30 days) and the legacy space is not expected to be rolled back to.
4. A database snapshot has been taken.
5. The owner has approved it in writing (`TODO(owner)`; record where the approval lives).

### How it is guarded

- The `NNN_` prefix is a placeholder. It is not a number, so it cannot be sorted into
  `migrations/` or mistaken for the next real migration.
- `up` throws unless `KC_DEFERRED_MIGRATION_APPROVED=drop-legacy-embedding-column` is set.
  A file moved into `migrations/` by mistake therefore fails the pipeline instead of
  dropping the column. The reviewed commit that approves it removes this guard.
- `up` also refuses to run if any chunk holds a legacy vector that the legacy space
  (`cohere-v3-1024`) does not hold, so no vector is lost that exists nowhere else.
- `down` restores the column (`vector(1024)`), backfills it from the legacy space's
  current vectors, and recreates the HNSW index, the mirror function and the trigger.

### Rehearsing it (safe)

The Docker harness applies it on top of migrations 032 and 033 in a throwaway container
and then reverts it, proving that the down path restores the column and the index:

```powershell
node cdk\lambda\db_setup\tests\docker_migration_check.js --deferred
```

Do not run it against any shared or production database from this folder.
