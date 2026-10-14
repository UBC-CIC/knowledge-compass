# Runbook: swapping the embedding model

Knowledge Compass finds answers by comparing a family's question with stored passages of your content. Both are turned into numbers by an **embedding model**. This runbook is the procedure for moving to a different embedding model (or a different vector size) without taking chat down.

Everything below is done from the admin console page **Search index**. No deploy is needed to swap a model.

> **What this document does not claim.** It does not say which models exist, what they cost, when any model reaches end of life, or whether a model is available in `ca-central-1`. Those lookups were deliberately skipped by the project owner. Model ids, inference-profile ARNs, prices and end-of-life dates are **configuration you enter** on the index you register. Check them against AWS before you rely on them.

## Placeholders to fill in

| Placeholder | Meaning |
|---|---|
| `TODO(owner)` | The person or team who owns each step. Filled in per step below. |
| `TODO(CIC policy reference)` | The Inclusion Canada policy on model lifecycle and data residency that approves a model swap. |
| `TODO(alert channel/endpoint)` | Where lifecycle and cutover alerts are delivered (see [Alert channel](#alert-channel)). |

## 1. Purpose and when to use it

Use this runbook when:

- the lifecycle check (see [Lifecycle alerts](#9-lifecycle-alerts)) says the model in use is not `ACTIVE`, is missing, or ends within 90 days;
- you want a better or cheaper model, or a smaller vector size;
- the current model is failing or has been retired by AWS (see [When to use the banner or read-only mode](#8-when-to-use-the-banner-or-read-only-mode)).

How it works, in one paragraph. A new index (a "space": one model, one vector size, one version) is built **next to** the live one from the chunks already stored, so no original upload is needed. It is checked against a fixed set of test questions. Activation moves a single pointer to the new space. Chat keeps answering from the old space until that instant. Only **syncing** (adding or updating content) pauses, for a few minutes. The old space is kept for 30 days so a rollback is one click.

## 2. Prerequisites

- [ ] Database migrations 032, 033 and 034 are applied (`cdk/lambda/db_setup/migrations/`). 034 adds the banner and read-only switch.
- [ ] Access to the candidate model is enabled in Amazon Bedrock for the region you will call.
- [ ] The IAM grants for the candidate models are deployed (`cdk/lib/ingestion-stack.ts` and `cdk/lib/api-stack.ts` list Titan Text Embeddings V2 and Cohere Embed v4 next to the current Cohere v3). Model ids and inference-profile ARNs are configuration; these grants enable candidates and do not assert availability in any region.
- [ ] The golden question set is present: `cdk/lambda/textGeneration/tests/eval/golden_queries.json` (71 synthetic questions) and its copy in `cdk/lambda/knowledgeBase/helpers/golden_queries.json`. Never replace them with real chat messages.
- [ ] A recent database snapshot exists.
- [ ] You have read [Where inference runs](#3-where-inference-runs-and-data-residency).

## 3. Where inference runs, and data residency

The application is deployed in `ca-central-1`. A model id you enter is called in that region. **Cross-region inference profiles are acceptable per the owner's decision**, but they mean the text of your content and of families' questions **may be processed in other regions** while the model runs. For Inclusion Canada that has data-residency implications.

Before registering an index that uses an inference profile, confirm the policy: `TODO(CIC policy reference)`.

## 4. Steps

Owners are placeholders. Durations are expectations, not measurements.

| # | Step | Where | What to do | Expected duration | Owner |
|---|---|---|---|---|---|
| 1 | Compare candidates offline | A terminal with a database and Bedrock access | `py -3 cdk\lambda\textGeneration\tests\eval\run_eval.py cdk\lambda\textGeneration\tests\eval\golden_queries.json --candidate` (set `EVAL_DATABASE_URL`; use `--candidates`, `--invoke-target name=ID_OR_ARN` and `--price name=USD_PER_1M` as needed). It reads a read-only snapshot and prints ids, ranks and metrics only, never chunk text. | Minutes to an hour, depending on corpus size | `TODO(owner)` |
| 2 | Register the index | **Search index** > **Register a new index** | Name, provider, dimensions, model id, the id or ARN to call, and optionally price, end-of-life date and score thresholds. It starts as **Building** and changes nothing for families. | Under a minute | `TODO(owner)` |
| 3 | Dry run | **Manage** > **Dry run (estimate only)** | Counts what needs embedding and estimates tokens, cost and time. Writes nothing. The cost line reads `price not configured` unless you entered a price. **Start rebuild** stays disabled until a dry run has finished. | A few minutes | `TODO(owner)` |
| 4 | Rebuild | **Start rebuild** | Embeds every chunk that lacks a current vector. Ingestion keeps running and chat is unaffected. Throttling is retried; a failed rebuild keeps its place and can be started again. | The dry-run estimate | `TODO(owner)` |
| 5 | Validate | **Check quality** | Runs the checks below. The index becomes **Ready to activate** only when all pass. | A few minutes | `TODO(owner)` |
| 6 | Activate | **Activate** (confirm) | Pauses syncing, waits for running syncs, catches up, re-checks, flips the pointer, checks again. | The dry-run estimate for any remaining chunks, plus 5 to 10 minutes of cutover steps | `TODO(owner)` |
| 7 | Post-flip check and monitoring | Job panel, CloudWatch | The job re-runs the golden set against the new live index. Two alarms watch it (see [Monitoring](#monitoring)). Watch chat for a day. | 1 to 2 minutes in the job, then monitoring | `TODO(owner)` |
| 8 | Roll back, if needed | **Roll back to this index** on the retired index | Same steps as activation, in reverse. | 5 to 10 minutes plus catch-up | `TODO(owner)` |
| 9 | Retention | After 30 days | **Purge…** the retired index (typed confirmation). Manual only, never automatic. | Minutes | `TODO(owner)` |
| 10 | Final cleanup of the old column | Database, with separate approval | The legacy `chunks.embedding` column and its index are removed by a prepared migration that is **not** applied by deploys. See [Final cleanup](#7-final-cleanup-of-the-legacy-column). | Minutes | `TODO(owner)` |

### Validation criteria (step 5)

All of these must hold:

1. **Coverage:** zero chunks without a current vector in the new index.
2. **By kind of source:** no gaps for any kind of source (web, document, video, CSV row), and nothing that only the live index covers.
3. **Search quality:** on the golden questions, recall at 5 and recall at 15 of the new index are no worse than the live index minus a tolerance. The default tolerance is **0.05**. It can be changed per run through the API (`tolerance`, 0 to 0.5) or by the `VALIDATE_RECALL_TOLERANCE` environment variable on the knowledge-base Lambda.

Questions marked `near_miss` or `off_topic` in the golden set are informational. They only feed a **suggested** minimum match score, which is never applied automatically.

### Steps 6 and 8: what happens

1. Syncing pauses (`CUTOVER_LOCKED`: the four sync entry points answer 409).
2. Wait until no sync is running (up to `ACTIVATE_IDLE_TIMEOUT_SECONDS`, default 900 seconds; on timeout the job fails and syncing resumes).
3. Catch up whatever the new index still lacks.
4. Re-check coverage (and quality, for an activation).
5. Flip, in one database transaction: old index retired, new index active, pointer moved.
6. Wait about 65 seconds so every chat container sees the change, catch up late writes, and run the golden set against the new live index.
7. Syncing resumes, always, even if an earlier step failed.

**Why a failed post-flip check does not roll back by itself:** an automatic rollback could flip live traffic twice within minutes on a flaky check. The job is marked failed, the `PostFlipCheckFailed` alarm fires, and a person decides whether to use **Roll back**.

## 5. Rollback

A retired index stays complete for 30 days. On the retired index choose **Roll back to this index**. The job brings that index up to date first (it received no writes while retired), re-checks coverage, flips back, and runs the post-flip check. Expect 5 to 10 minutes plus catch-up. The index that was live becomes retired and is itself kept for 30 days.

## 6. Retention and purge

- A retired index is kept **30 days** (`RETENTION_DAYS` in `embedding_admin.py`; the screen shows the date it becomes eligible).
- **Purge…** deletes that index's vectors and its search index. It is manual only: there is no schedule and no automatic path.
- The server refuses a purge unless the index is retired (never active, building or validated), has been retired for the full 30 days, no cutover holds the lock, no job is running for it, and the typed name matches the index name exactly (case-sensitive). The check does not depend on the screen.
- A purge that is interrupted can simply be sent again.

## 7. Final cleanup of the legacy column

Migration 032 kept the old `chunks.embedding` column, its `idx_chunks_embedding_hnsw` index and a mirror trigger so old code kept working during the rollout. They are removed by a prepared cleanup that is deliberately **not** in `cdk/lambda/db_setup/migrations/`, so no deploy applies it:

`cdk/lambda/db_setup/deferred/NNN_drop_legacy_embedding_column.js` (see `deferred/README.md`).

Approval gate, all required: retrieval and writers on the active space are deployed and verified in production; the rollback window is closed; a snapshot exists; the owner `TODO(owner)` has approved in writing. The migration refuses to run without the approval variable and refuses if any legacy vector exists nowhere else. Its `down` restores the column, index, function and trigger. Rehearse it in a throwaway container with `node cdk\lambda\db_setup\tests\docker_migration_check.js --deferred`.

## 8. When to use the banner or read-only mode

**Not the default.** While the old index stays live and the new one builds, chat keeps working. The only interruption is syncing pausing for a few minutes during activation. Use the banner or read-only mode only when you cannot avoid an interruption, for example when the old model has already stopped working.

Where: admin console > **Assistant settings** > **Service status**. No deploy is needed; it takes effect within about a minute.

| Setting | What families see |
|---|---|
| Normal | Nothing. |
| Show a banner | Your message above the chat. Chat keeps working. |
| Pause new messages (read-only) | Your message, a disabled message box, and a clear message if a message is attempted (`SERVICE_READ_ONLY`). |

A message is required for the banner and read-only. Keep it short, in plain language, and free of private details.

> **Security note: public endpoint.** The chat page reads the setting from `GET /system-settings/service-status`. Although it is guarded by the anonymous public-session token, **any visitor can read it**. It deliberately returns only the status and the message, nothing else, and its response may be cached for 30 seconds. Never put anything private in the message, and do not add fields to that endpoint. The chat polls at most once a minute using the token it already holds, so the request counts under the web firewall's authenticated limit rather than the stricter anonymous one.

## 9. Lifecycle alerts

A weekly Lambda (`<stack id>-lifecycleCheck`, schedule `rate(7 days)`) lists the models the system depends on:

- every non-purged embedding index, with the end-of-life date you entered (it may be empty, which is not an alert by itself);
- the generation models named by the SSM parameters `/KC/LLM/HaikuArn` and `/KC/LLM/SonnetArn`.

It sends **one** message to the SNS topic `<stack id>-ModelLifecycleAlerts` when a model is not `ACTIVE`, is missing from the Bedrock model list in its region, ends within **90 days** (or already ended), or when a region could not be checked ("check failed"). The message lists model id, region, reason and days left, and nothing secret.

On an alert: open the runbook at step 1, compare candidates, and plan a swap before the date. "Check failed" usually means a temporary Bedrock or network problem; invoke the function again from the AWS console to re-check.

### Alert channel

`TODO(alert channel/endpoint)`. The topic exists but has no subscriber until you provide one at deploy time:

- `cdk deploy --all -c lifecycleAlertEmail=<address>`, or
- `cdk deploy --all -c lifecycleAlertEmailParam=<name of an SSM String parameter that holds the address>` to keep the address off the command line.

The same topic receives the two alarms in [Monitoring](#monitoring).

### Monitoring

| Alarm | Fires when | What to do |
|---|---|---|
| `EmbeddingSpaceCheckFailedAlarm` | The live index failed its consistency check; chat answers `EMBEDDING_SPACE_UNAVAILABLE` | Fix the index, or roll back if you just activated. |
| `PostFlipCheckFailedAlarm` | The golden-set check after a switch failed; the new index is live | Read the job report; use **Roll back** if search quality dropped. |

Both are CloudWatch alarms on the `KnowledgeCompass/Embeddings` namespace, written as log lines by the Lambdas (no extra permission).

## 10. Troubleshooting

| Symptom | Likely cause and action |
|---|---|
| Chat says the assistant is temporarily unavailable (`EMBEDDING_SPACE_UNAVAILABLE`) | The live index is missing, has the wrong size, or its search index is gone. This is deliberate: serving answers from a different model than the vectors were made with would silently return wrong results. Check the alarm, fix it, or roll back. |
| "A search-index cutover is in progress" when syncing | A switch holds the lock. It clears when the job finishes. A lock older than **30 minutes** counts as released automatically, so a crashed job cannot block syncing for good. |
| Rebuild is slow or fails with throttling | Calls are retried with adaptive retry, then per batch with exponential backoff (2 s doubling to 60 s, up to 5 attempts). A failed rebuild keeps its place: run a dry run and **Start rebuild** again to resume. A job with no progress for 15 minutes is marked failed when you start the next one. |
| **Start rebuild** is disabled | Run **Dry run** first and wait for the estimate. |
| **Activate** is disabled | Only a validated index can be activated, and not during another switch. |
| Validation fails on quality | Compare the table of recall figures. Consider another model or size, or (with care) a different tolerance. Do not lower the tolerance just to pass. |
| Purge is refused | The message names the reason: not retired, active, retired less than 30 days ago, a job is running, locked, or the typed name does not match. |
| Banner or read-only will not clear | Set Service status back to Normal and save. Allow about a minute (the status is cached for up to 30 seconds and polled every minute). |

## 11. How this was verified

Recorded when the feature was implemented, so you know what the evidence covers.

**Ran, and passed:**

- Frontend: `npm run lint` clean; `npm test` 6 files, 64 tests; `npm run build`.
- CDK: `npm run build`; `npm run test:lambda` 99 tests; `npx jest test/openapi-contract.test.ts test/legacy-copy.test.ts` 2 suites, 10 tests; `npx cdk synth` succeeds (including with and without `lifecycleAlertEmail`).
- Python (`unittest`): textGeneration 314 tests; knowledgeBase 325 tests with only the 3 import errors that existed before this work (the local interpreter lacks `lxml`); containers 49; lifecycleCheck 29.
- Database, in a throwaway Docker PostgreSQL 16 with pgvector: migrations 032, 033 and 034 up and down, the real SQL of the writers, retrieval, cutover and validation, and the deferred cleanup (up refusal, data-loss guard, down restoring column, index, function and trigger): 56 checks passed.

**Could not be run, and why:**

- Anything against **live Bedrock** (embedding calls, `list_foundation_models`): no AWS access was used. No model availability, price or end-of-life date was checked, by the owner's decision.
- A **real deployment**: the Lambdas in the VPC reaching the Bedrock control plane through the NAT gateway, SNS delivery, the weekly schedule, the alarms, API Gateway and the web firewall behaviour.
- The real RDS: ownership of the `chunks` table and the production-size timing of the backfill and index builds. The design does not depend on the owner, but this was not confirmed.
- **Manual accessibility testing** with a screen reader and keyboard on the new screens. The screens use labelled fields, the Radix dialog (focus trap, Escape), text progress in a polite live region and plain tables, but full validation needs manual testing with assistive technologies and expert review.
- No browser-level test of the chat banner or the read-only composer.
