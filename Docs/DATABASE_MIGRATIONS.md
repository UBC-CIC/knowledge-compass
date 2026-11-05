# Database Migrations

## Table of Contents

- [How Migrations Run](#how-migrations-run)
- [Adding a Migration](#adding-a-migration)
- [Rules](#rules)
- [Patterns in This Repo](#patterns-in-this-repo)
- [Testing](#testing)
- [Rollback](#rollback)

## How Migrations Run

- Migrations are JavaScript files in `cdk/lambda/db_setup/migrations/`, run by [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/) from `cdk/lambda/db_setup/index.js`.
- The `<PREFIX>-DBFlow` stack runs that Lambda as a CDK trigger on every deploy. It applies all pending migrations in filename order, `up` only, and records each one in the `pgmigrations` table.
- The API stack depends on DBFlow (`apiStack.addDependency(dbFlowStack)` in `cdk/bin/cdk.ts`), so `npx cdk deploy --all` applies migrations before the code that needs them.
- Files in `cdk/lambda/db_setup/deferred/` are never run. See [Deferred changes](#rules).

## Adding a Migration

1. Name the file `NNN_description.js`, where `NNN` is the highest existing number plus one (currently `050`). Prefixes `032`, `033` and `034` each have two files, so check the highest number rather than the last file listed.
2. Export `up` and normally `down`. Write SQL with `pgm.sql` and make it idempotent (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object …`), so a retried deploy does not fail.
3. Use `uuid_generate_v4()` for UUID defaults, as every existing migration does.

```javascript
// cdk/lambda/db_setup/migrations/050_add_example_table.js
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS example (
      id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
      name        text        NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS example;`);
};
```

## Rules

- **Never rewrite a migration that has been applied.** `pgmigrations` records it by name, so an edit never runs on existing databases. Write a new migration instead.
- **Backfill before `NOT NULL`.** Add the column as nullable, fill every row, then `SET NOT NULL` (and a default) in the same migration. Example: `039_user_identity_source.js`.
- **Enum values need `pgm.noTransaction()`.** `ALTER TYPE … ADD VALUE` cannot run inside a transaction, and a new value cannot be used in the transaction that adds it. Call `pgm.noTransaction()` at the top of `up`, and when a later step uses the value, put the enum change in its own earlier migration (`015_csv_link_source_type.js` adds `csv_link`; `016_csv_row_links.js` uses it). PostgreSQL cannot drop enum values, so `down` leaves them in place.
- **Destructive changes go in `deferred/`.** A drop that could lose data is written as a placeholder `NNN_` file in `cdk/lambda/db_setup/deferred/` with an approval gate, and moves into `migrations/` only after that gate is met. See [`deferred/README.md`](../cdk/lambda/db_setup/deferred/README.md).

## Patterns in This Repo

Copy from a real migration rather than writing from scratch:

| Change | Example |
|---|---|
| Add enum values (`noTransaction`) | `002_inclusion_canada_prompts.js`, `015_csv_link_source_type.js` |
| New table with foreign key and index | `021_session_feedback.js` |
| pgvector column and HNSW index | `011_hnsw_embedding_index.js`, `032_embedding_spaces.js` |
| Backfill, then `NOT NULL` | `039_user_identity_source.js` |
| Seed or replace a system message without overwriting admin edits | `044_shorten_welcome_message.js` |

A data seed that must not duplicate rows uses `INSERT … SELECT … WHERE NOT EXISTS`:

```sql
INSERT INTO system_messages (type, content, character_limit, version, is_active, affects_text_generation, created_at)
SELECT 'disclaimer', 'AI can make mistakes. Check important info.', 400, 1, true, false, now()
WHERE NOT EXISTS (SELECT 1 FROM system_messages WHERE type = 'disclaimer');
```

## Testing

Run from `cdk/`:

```bash
npm run test:lambda   # node --test "lambda/**/tests/*.test.js", including lambda/db_setup/tests/
npm test              # CDK Jest tests in cdk/test/
```

Add a `*.test.js` file in `cdk/lambda/db_setup/tests/` for a migration with logic worth checking (see `userIdentitySource.test.js` or `serviceStatus.test.js`).

`node lambda/db_setup/tests/docker_migration_check.js [--deferred]` is an optional manual rehearsal. It needs Docker, starts a throwaway `pgvector/pgvector:pg16` container, applies migrations 000–034 with specific checks for 032, 033 and 034, and with `--deferred` applies and reverts the deferred file. It does not cover later migrations.

The database sits in isolated subnets behind RDS Proxy, so you cannot run migrations against it from a laptop. Deploy the DBFlow stack instead.

## Rollback

- CloudFormation never runs `down`. A failed or rolled-back deploy leaves applied migrations in place.
- Production recovery is roll-forward: fix the problem in a new migration.
- Take an RDS snapshot before any destructive change.
- `down` exists for local rehearsal (for example the Docker harness's down/up round trip). Keep it correct, but do not rely on it in production.
