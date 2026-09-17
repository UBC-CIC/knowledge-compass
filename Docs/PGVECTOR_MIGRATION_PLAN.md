# pgvector Migration Plan

Status: Draft for review
Owner: (assign)
Last updated: 2026-09-02

This document is the authoritative plan for migrating Knowledge Compass retrieval
from Amazon Bedrock Knowledge Bases + OpenSearch Serverless to a self-hosted
RDS PostgreSQL + pgvector pipeline. It records confirmed decisions, the target
architecture, the phased migration, and the open items still to resolve.

---

## 0. Remaining-to-complete checklist

Legend: [x] done · [ ] not started · (CODE) doable in this repo now ·
(AWS) needs a live dev stack / AWS creds · (YOU) requires the owner (secrets/console).

Prepared locally (done):
- [x] Phase 0 code — de-secret scripts, shared config helper, build baseline (CODE)
- [x] Phase 1 — `001_unified_chunks.js` schema migration (CODE)
- [x] Phase 2 — `retrieval.py` + feature flag + unit tests (CODE)
- [x] Phase 3 — `002_inclusion_canada_prompts.js` + config/logic/chat rewrite (CODE)
- [x] Phase 3 follow-ups — chat.py + intervention.py domain rewording (CODE)
- [x] Phase 4/5 — crawler/transcriber reconciled + Dockerfiles (CODE)
- [x] Phase 4/5/6 — architecture + cutover procedure documented (CODE)

Still to do:
- [ ] R1. Rotate the leaked RDS credential (commit b3a9024) (YOU)
- [x] R2. Ingestion CDK scaffold — ECS cluster/task defs + ECR repos + roles (CODE done, SYNTH-PENDING)
- [x] R3. Repurpose admin ingestion Lambda -> pgvector ECS trigger (CODE done)
- [x] R4. Drop `specialization_list` (migration 003 + all consumers) (CODE done)
- [ ] R5. Apply migrations 001 + 002 (+003) to the dev DB; `ANALYZE chunks` (AWS)
- [ ] R6. Load a representative corpus (web + video + document) (AWS)
- [ ] R7. Run the Python unit tests in a real Python 3.12 env (AWS/YOU)
- [ ] R8. Live-validate retrieval with `USE_PGVECTOR_RETRIEVAL=true` (AWS)
- [~] R9. Comparison harness written (tools/compare_retrieval.py). RUN it on the
        dev stack + set numeric acceptance thresholds (AWS/YOU)
- [~] R10. Retirement runbook written (RETIREMENT.md). EXECUTE the cutover + bake +
        KB/OpenSearch retirement on live AWS (AWS/YOU)
- [ ] R11. Commit the changes (currently all untracked/modified in the working tree) (YOU)
- [x] R12. Ingestion wiring — api-stack env + grantRunTasks, CICD build context.
        CODE done AND `cdk synth` PASSES for the full app (all 8 stacks) with the
        nav-dev profile. Deploy still required. (AWS)

R2, R3, R4 and R12 are complete and `cdk synth`-validated. R1 and R5–R11 (plus the
actual `cdk deploy` of R12) require live AWS or owner action.

Tooling fixes made to get synth working (committed separately):
- Bumped the `aws-cdk` CLI devDependency 2.1022.0 -> 2.1115.0 to match the
  aws-cdk-lib 2.245.0 cloud-assembly schema (was schema 48 vs 53 mismatch).
- Use the LOCAL CLI (`node_modules/.bin/cdk`), not `npx cdk` (npx resolved a
  different package literally named "cdk").
- Remove stale compiled bin/*.js + lib/*.js before synth so `ts-node` runs the
  .ts source (cdk.json app = ts-node bin/cdk.ts); stale .js shadowed it.
- Synth command (from cdk/):
  `node_modules/.bin/cdk.cmd synth --context StackPrefix=KC --context environment=dev
   --context githubRepo=<repo> --context githubBranch=main --context versionNumber=1`
  with AWS_PROFILE=nav-dev, CDK_DEFAULT_ACCOUNT=825243640171, CDK_DEFAULT_REGION=ca-central-1.

---

## 1. Confirmed decisions

These are locked based on stakeholder input.

| # | Decision | Choice |
|---|----------|--------|
| 1 | Bedrock Knowledge Base after migration | Fully retire it after cutover to minimize cost. Keep only as a short-lived rollback path. |
| 2 | Embeddings | Reuse existing chunk embeddings; re-embed only when a chunk's content changes (content-hash change detection). |
| 3 | Crawler deployment shape | Follow the handoff design: Admin/API -> proxy Lambda -> ECS Fargate task -> RDS. |
| 4 | Recrawl scheduling | Configurable frequency, but launch with manual trigger only. Scheduling added later. |
| 5 | Frontend source display | Deferred; frontend is being partially rebuilt. Retrieval must at minimum return the source URL. |
| 6 | Ingestion tracking model | One unified ingestion-run model. |

Workshop answers:

- pgvector is the future source of truth (cost-driven).
- Launch content types: web, video, and documents (all three).
- Canonical first crawl domain: to be provided later.
- Minimum citation: URL (richer citation is a later enhancement).
- Environments: a dedicated dev stack is required.
- Cost/quality target: lowest cost that still delivers acceptable retrieval quality.

---

## 2. Current state (ground truth as of this draft)

- `cdk/lambda/db_setup/migrations/000_initial_schema.js` is the ONLY migration present.
  - It already runs `CREATE EXTENSION IF NOT EXISTS "vector";`.
  - It creates `users`, `data_sources`, `ingestion_runs`, `chat_sessions`,
    `chat_messages`, `system_messages`, `system_settings`.
  - It seeds UBC-specialization prompts and a UBC `specialization_list`.
  - The `sources` / `chunks` tables from the handoff do NOT exist yet. The
    `001/002/003` migrations described in `Project Refactoring/README.md` are
    aspirational, not implemented.
- `cdk/lambda/textGeneration/helpers/bedrock.py` exposes:
  - `retrieve_documents(query, knowledge_base_id, region, num_results, search_type)`
    returning a list of dicts shaped like:
    `{ "type", "uri", "url", "content", "score" }`.
  - `format_context_for_prompt(sources)` which renders `<source_i>...</source_i>` blocks.
  - The new pgvector retriever MUST return the same shape so `chat.py` and the
    frontend need no structural change.
- Prototype assets live in `Project Refactoring/`:
  - `crawler/crawler.py` (+ `README.md`, `requirements.txt`)
  - `transcriber/transcrbe.py` (+ `README.md`, `requirements.txt`)
  - `textgen_v1.ipynb` (reference RAG flow, prompts, `retrieve()` + `format_context()`)
  - `user-stories/` (Inclusion Canada journeys, features, language toolkit)
- SECURITY: `crawler/crawler.py` contains a hard-coded RDS host and a
  password/token literal. This must be rotated and removed before any further use.

---

## 3. Target architecture

```
React / Amplify
  -> API Gateway (REST) + WebSocket
    -> text-generation Lambda (unchanged orchestration)
       - guardrails, session security, message limits, history, streaming
       - NEW: retrieve_from_pgvector()
         -> RDS PostgreSQL + pgvector
            - sources
            - chunks
            - ingestion_runs (unified)

Ingestion:
  Admin trigger (API) -> proxy Lambda -> ECS Fargate crawler task -> sources/chunks
  Admin upload video  -> S3 event -> Lambda -> Transcribe -> chunks (with timestamps)
```

Removed after cutover: Bedrock Knowledge Base, OpenSearch Serverless collection,
KB provisioner + vector index custom resources, KB secret wiring.

---

## 4. Unified data model (target)

One retrieval corpus for web, video, and documents.

`sources`
- `id uuid pk`
- `name varchar`
- `url varchar unique` (canonical URL; required for citation)
- `source_type` enum: `web` | `video` | `document`
- `created_at`, `updated_at timestamptz`
- `metadata jsonb`

`chunks`
- `id uuid pk`
- `source_id uuid fk -> sources(id)`
- `chunk_index int`
- `body text` (human-readable chunk)
- `embed_text text` (text actually embedded; may include heading path)
- `word_count int`
- `content_hash varchar` (sha256[:16] of body; drives re-embed decisions)
- `embedding vector(1024)` (Cohere embed-english-v3)
- `metadata jsonb` (web: `{heading_path}`; video: `{chunk_start, chunk_end}`; document: page/section)
- `updated_at timestamptz`
- unique `(source_id, chunk_index)`

Ingestion tracking: extend the existing `ingestion_runs` table into the single
unified model (status: `pending|queued|running|completed|failed`, plus counters
for pages/chunks upserted/deleted, error_message, timestamps). Avoid introducing
separate `crawl_runs` / `video_*` tables so there is one source of truth.

Indexes:
- Vector index on `chunks.embedding`. Start with IVFFlat (cosine) for lowest cost
  on a small corpus; revisit HNSW only if recall/latency require it.
- Btree on `chunks(source_id)` and `sources(source_type)`.

Note: This means writing a new migration (e.g. `001_unified_chunks.js`) that
supersedes the aspirational `001/002` in the handoff and consolidates into
`sources` + `chunks` + unified `ingestion_runs`.

---

## 5. Retrieval contract (must not break chat.py / frontend)

New module: `cdk/lambda/textGeneration/helpers/retrieval.py`

`retrieve_from_pgvector(query, db_connection, top_k, min_score, region) -> List[Dict]`
returning items shaped to match the current `retrieve_documents()` output:

```
{
  "type": "web" | "video" | "document",
  "uri": <canonical url>,
  "url": <canonical url>,
  "content": <chunk body>,
  "score": <cosine similarity 0..1>,
  "metadata": {...}   # optional passthrough (heading_path, timestamps)
}
```

Behavior:
1. Embed the query with Cohere embed-english-v3, `input_type="search_query"`.
2. Cosine similarity query against `chunks` joined to `sources`.
3. Filter by `min_score`, dedupe by URL, limit to `top_k`.
4. Reuse the existing pooled DB connection from `db_connection.py`.
5. `format_context_for_prompt()` stays as-is.

`chat.py` change is a single call-site swap:
`retrieve_documents(search_query, knowledge_base_id, ...)` ->
`retrieve_from_pgvector(search_query, db_connection, ...)`, gated behind a
feature flag during validation.

---

## 6. Phased migration

### Phase 0 - Security and baseline (do first)
- Rotate/revoke the credential embedded in `crawler.py`; purge it from tracked files.
- Remove hard-coded host/region/credentials from all prototype scripts and the notebook.
- Standardize credential access: Secrets Manager + RDS Proxy for Lambda; RDS IAM auth
  (or Secrets Manager) for ECS tasks and SageMaker/local tooling.
- `npm ci` in `cdk/` and `frontend/`; capture a passing build/lint/test baseline.
- Add `.gitignore` entries for crawl outputs and downloaded RDS CA bundle.
Exit: no secrets in tracked source; reproducible build baseline; agreed cred pattern.

### Phase 1 - Database foundation
- Add `001_unified_chunks.js`: `sources`, `chunks`, unified `ingestion_runs` extensions,
  vector + btree indexes. `vector` extension already exists from `000`.
- Provide a tested `down` migration.
- Validate on the dev stack with a representative similarity query.
Exit: schema deploys cleanly on dev and supports a sample retrieval.

### Phase 2 - Retrieval extraction
- Create `helpers/retrieval.py` from the notebook `retrieve()` + `format_context()`.
- Add feature flag (env var) selecting pgvector vs Bedrock KB retrieval.
- Unit tests: query embedding, ranking, min_score filter, URL dedupe, contract shape.
Exit: a controlled request retrieves expected chunks and returns the current source shape.

### Phase 3 - Inclusion Canada conversational behavior
- Replace UBC prompts/`specialization_list` with Inclusion Canada prompts from
  `textgen_v1.ipynb` (system_role, guardrails, language guidelines, detective, suggestion).
- Move prompt content into `system_messages` / `system_settings` seeds (new migration).
- Validate against `user-stories/` acceptance scenarios and the language toolkit.
Exit: user-story prompts produce grounded, correctly phrased answers with URL citations.

### Phase 4 - Web crawler deployment
- Refactor `crawler.py` into a config-driven, secret-free ECS Fargate task (Docker + Chromium).
- Proxy Lambda: validate request, insert `ingestion_runs` row (`queued`), RunTask on ECS.
- ECS task updates run status to `completed`/`failed`; admin polls status.
- Add crawl limits, domain allowlist, retries, robots.txt policy, monitoring.
- Manual trigger only for launch; keep content-hash change detection (decision #2).
Exit: admin can crawl the approved domain, observe status, and query new content.

### Phase 5 - Video + document ingestion
- Productionize `transcrbe.py`: Transcribe JSON -> chunked `chunks` with timestamp metadata.
- Add document ingestion path writing into the same `sources`/`chunks` model.
- Validate mixed-source ranking (web + video + document) in one query.
Exit: a response can cite web, video (with timestamps), and document sources together.

### Phase 6 - Cutover and retirement
- Run pgvector vs Bedrock KB in comparison mode for a defined window.
- Measure grounding quality, latency, cost, failure rate, citation correctness.
- Flip primary retrieval to pgvector; keep KB fallback briefly.
- Remove Bedrock KB / OpenSearch / KB provisioner / vector index resources from CDK.
Exit: pgvector meets quality + reliability thresholds; KB infra removed; cost reduced.

---

## 7. Cost posture (lowest cost for acceptable quality)

- Retrieval compute moves onto the existing RDS instance (no OpenSearch Serverless OCU cost).
- Embeddings: only re-embed changed chunks (decision #2) to minimize Bedrock embed calls.
- Crawler runs on-demand via ECS Fargate (pay per run), manual trigger at launch.
- Prefer Claude Haiku for generation and query rewrite; escalate to Sonnet only if
  quality is inadequate.
- Start with IVFFlat vector index (cheaper build/memory) given small corpus.
- Keep dev stack minimal and tear down on-demand resources when idle.

---

## 8. Open items to resolve

1. Canonical first crawl domain and expected recrawl cadence (default manual).
2. Document ingestion sources/formats for launch (PDF, CSV, JSON, markdown?).
3. Dev stack definition: separate stack prefix/account? RDS sizing for dev?
4. Prompt migration path: DB-seeded `system_messages` vs managed config.
5. Concrete quality/latency/cost thresholds that define "acceptable" for cutover.
6. Whether `data_sources` (existing) should merge into `sources`, or remain the
   admin-facing config table pointing at `sources`.

---

## 9. Recommended first implementation tasks

1. Phase 0 security cleanup (rotate credential, de-secret scripts, build baseline).
2. Phase 1 `001_unified_chunks.js` migration + dev-stack validation.
3. Phase 2 `helpers/retrieval.py` + feature flag + unit tests.

These three unblock everything else and are low-risk because they do not remove
the existing Bedrock KB path yet.

---

## 10. Phase 0 progress log

Status: Source-side cleanup complete. AWS-side credential rotation still required (manual).

Done:
- Added `Project Refactoring/common/db_config.py` — secret-free, env-driven DB/AWS
  config with three credential modes (`iam` default, `secret`, `password`).
- Refactored `crawler/crawler.py` and `transcriber/transcrbe.py` to use the shared
  helper. Removed all hard-coded RDS host, region, SSL cert path, and the
  hard-coded password/token literal.
- Sanitized `textgen_v1.ipynb` (it contained the same hard-coded host + token):
  config now reads from `os.environ`, and the connection cell generates an RDS IAM
  auth token at runtime instead of embedding a secret.
- Verified via grep that the hard-coded host and token no longer appear anywhere
  under `Project Refactoring/`.
- Added `Project Refactoring/.env.example` template (placeholders only).
- Updated `.gitignore` to exclude crawl/transcribe outputs, downloaded RDS CA
  bundles, and `.env` files (keeping `.env.example`).
- Updated `crawler/README.md` and `transcriber/README.md` with the secret-free
  configuration model and rotation warning.

STILL REQUIRED (manual, cannot be done from source):
- **Rotate/revoke the RDS credential** that was previously hard-coded. It remains
  in git history at commit `b3a9024` and must be considered compromised.
  Steps: change the `app_rw` DB user's password (or disable password auth and use
  RDS IAM auth exclusively), update any consumer to the new secret, and confirm the
  old value no longer grants access.
- Decide whether to scrub git history (e.g. `git filter-repo`) or accept history
  exposure and rely on rotation. Rotation is mandatory either way.

Not yet started (next in Phase 0):
- `npm ci` in `cdk/` and `frontend/` to establish a passing build/lint/test baseline.

---

## 11. Build/lint/test baseline (Phase 0)

Captured after `npm ci` in both `cdk/` and `frontend/` (reproducible from lockfiles).

| Check | Command | Result |
|---|---|---|
| CDK build | `cdk> npm run build` (tsc) | PASS |
| CDK tests | `cdk> npm test` (jest) | FAIL — no test suite exists |
| Frontend build | `frontend> npm run build` (tsc -b && vite build) | PASS |
| Frontend lint | `frontend> npm run lint` (eslint) | FAIL — 49 problems (41 errors, 8 warnings) |

Notes:
- **CDK tests**: `jest.config.js` sets `roots: ['<rootDir>/test']`, but no `cdk/test`
  directory exists, so jest errors with "Directory ... test ... was not found". This
  is a missing-suite condition, not a code defect. Add tests under `cdk/test` (see
  Phase 1/2 plan) to make this meaningful.
- **Frontend lint**: all 49 issues are pre-existing (predominantly
  `@typescript-eslint/no-explicit-any`, plus `no-useless-escape`, `no-empty`,
  unused vars, `react-hooks/exhaustive-deps`, `react-refresh/only-export-components`).
  None were introduced by the Phase 0 changes (which touched only Python + docs).
- **Frontend build**: succeeds; only a bundle-size advisory (main chunk ~1.45 MB).
- **Dependency audit**: `frontend` reported 17 vulns (2 low / 3 moderate / 10 high /
  2 critical); `cdk` reported 6 (1 low / 5 high). Not auto-fixed — `npm audit fix`
  can introduce breaking changes and should be reviewed deliberately.

Baseline meaning for the migration: builds are green, so retrieval/schema work in
later phases can proceed. Frontend lint and the absent CDK test suite are tracked
as known debt, not blockers for Phase 1.

---

## 12. Phase 1 progress log — database foundation

Status: Migration written and statically validated. Not yet applied to a live dev DB.

Delivered:
- `cdk/lambda/db_setup/migrations/001_unified_chunks.js` with `up` and `down`.
  - `source_type` enum: `web | video | document`.
  - `sources(id, name, url UNIQUE, source_type, created_at, updated_at, metadata)`.
  - `chunks(id, source_id FK->sources ON DELETE CASCADE, chunk_index, body,
    embed_text, word_count, content_hash, embedding vector(1024), metadata,
    created_at, updated_at)` with `UNIQUE(source_id, chunk_index)`.
  - Indexes: `idx_chunks_source_id`, `idx_sources_source_type`, and an IVFFlat
    cosine index `idx_chunks_embedding_ivfflat (lists=100)`.
  - Extended `ingestion_runs` (base table from 000) into the unified run model:
    added `source_id` (FK->sources ON DELETE SET NULL), `started_at`,
    `finished_at`, `pages_crawled`, `pages_skipped`, `chunks_upserted`,
    `chunks_deleted`, plus `idx_ingestion_runs_source_id`.
  - `down` reverses the ingestion_runs extensions and drops `chunks`, `sources`,
    and the `source_type` enum. It intentionally leaves the 000 base intact.

Validation done here:
- Node load-check: `up`/`down` are valid functions and the generated SQL contains
  all required elements (tables, `vector(1024)`, unique constraints, ivfflat,
  ingestion_runs columns).
- `cdk> npm run build` (tsc) still passes with the migration present.
- Migration mechanics confirmed: `db_setup/index.js` uses `node-pg-migrate` with
  `dir=migrations`, `direction=up`, `count=Infinity`, tracked in `pgmigrations`.
  So `001` runs automatically after `000` on the next db_setup invocation.
- `.gitignore` fix: the root-level `*.js` rule was ignoring new files under
  `cdk/lambda` because the `!lambda/...` negations are not anchored to `cdk/`.
  Added `!cdk/lambda/**/*.js`; confirmed `001_unified_chunks.js` is now tracked.

NOT yet done (requires a live database / dev stack):
- Apply the migration to a dev database and run a representative similarity query.
- Run `ANALYZE chunks` after loading data so the IVFFlat index is used; consider
  rebuilding `lists` to ~sqrt(rows) once corpus size is known.

### Reconciliation note (action required in Phase 4)

The prototype `crawler/crawler.py` still reads/writes a separate `crawl_runs`
table (`start_crawl_run`, `finish_crawl_run`, `crawl_runs` columns), which this
migration does NOT create. Per decision #6 (one unified ingestion-run model), the
crawler's run-tracking DB code must be updated in Phase 4 to target the unified
`ingestion_runs` table instead of `crawl_runs`. The chunk/source upsert code in
the crawler and transcriber already matches the `sources`/`chunks` columns created
here, so only the run-tracking portion needs reconciliation.

Also to confirm during Phase 3/admin work: whether the existing `data_sources`
table (admin-facing config from 000) should relate to `sources`, or be merged.
This migration leaves `data_sources` untouched.

### Sequencing decision (agreed)

Phase 3 (Inclusion Canada prompts/behavior) and the `data_sources`/`sources`
reconciliation are intentionally DEFERRED. We will complete the easier,
well-scoped phases first (Phase 2 retrieval extraction, then Phase 4/5 ingestion),
and review the non-trivial conversational/prompt work and schema reconciliation
together before implementing them.

---

## 13. Phase 2 progress log — retrieval extraction

Status: Retrieval module, feature flag, chat.py wiring, and unit tests complete.
Not yet exercised against a live DB (needs the dev stack).

Delivered:
- `cdk/lambda/textGeneration/helpers/retrieval.py`
  - `embed_query(query, region, embed_model_id)` — Cohere embed-english-v3,
    `input_type="search_query"` (matches the `search_document` space used at ingest).
  - `retrieve_from_pgvector(query, db_connection, region, num_results, min_score,
    min_results, embed_model_id)` — cosine search over `chunks` JOIN `sources`,
    score filter, URL de-dup, `num_results` cap, and a backfill so the model always
    gets at least `min_results` of context. Fail-soft: returns `[]` on embed or DB
    error, matching `bedrock.retrieve_documents` behavior.
  - Output is a SUPERSET of the legacy `retrieve_documents` shape
    (`type`/`uri`/`url`/`content`/`score`) plus `title`/`source_type`/`metadata`,
    so `format_context_for_prompt` and the rest of `chat.py` are unchanged.
- `helpers/config.py`: added `USE_PGVECTOR_RETRIEVAL` env flag (default `false`).
- `helpers/chat.py`: `_prepare_conversation` now branches on the flag — pgvector
  path passes the existing `db_connection`; the Bedrock KB path is unchanged and
  remains the default until validation.

Tests:
- `cdk/lambda/textGeneration/tests/test_retrieval.py` (stdlib `unittest`, no pytest
  dependency; mocks `embed_query` and uses fake cursor/connection). Cases:
  legacy-contract shape, `min_score` filtering, URL de-dup (highest-score-first),
  `num_results` cap, backfill below `min_results`, video `type` uppercasing,
  embedding-failure -> `[]`, DB-failure -> `[]`, and vector-literal formatting.
- Run with: `cd cdk/lambda/textGeneration && python -m unittest discover -s tests -v`.

Verification status:
- No Python interpreter is available on the current machine, so the tests were NOT
  executed here. Each test was manually traced against the module logic (row order,
  dedupe, backfill, fail-soft) and is consistent. Run the suite in a Python 3.12
  environment to confirm green before relying on it.
- New files confirmed git-trackable (not caught by `.gitignore`).

Follow-ups (not blocking Phase 2):
- Wire `min_score`/`min_results`/`embed_model_id` to DB-backed config in a later
  pass if we want them tunable without redeploy (currently sensible defaults).
- Consider adding these Python tests to CI once a Python test runner exists (the
  CDK jest suite is separate and still absent).
- Live validation belongs with the dev stack: apply migration 001, load a small
  corpus, set `USE_PGVECTOR_RETRIEVAL=true`, and compare retrieval output to the
  Bedrock KB path.

---

## 14. Phase 4 & 5 progress log — ingestion (crawler + transcriber)

Status: Ingestion scripts reconciled to the unified schema and containerized.
The AWS wiring (ECS/Fargate, proxy Lambda, EventBridge, admin API) is DESIGNED
here but NOT yet built in CDK — that requires the dev stack.

### Code reconciliation delivered

Crawler (`crawler/crawler.py`):
- Run tracking moved off the nonexistent `crawl_runs` table onto the unified
  `ingestion_runs` table. `start_crawl_run(conn, source_id, job_id=None)` adopts
  a pre-created run row when `job_id` is supplied (proxy-Lambda flow) or inserts a
  fresh `running` row otherwise. `finish_crawl_run(...)` sets status,
  page/chunk counters, `error_message`, `finished_at`, `completed_at`.
- `write_to_db(..., job_id=None)` threads the job id through; failures record the
  error on the run row.
- `main()` reads `SEED_URL`, `JOB_ID`, `MAX_PAGES`, `WRITE_DB`, `SEMANTIC` from
  env (ECS RunTask) with CLI args taking precedence; `seed_url` optional if env set.

Transcriber (`transcriber/transcrbe.py`):
- Fixed the stale `video_sources`/`video_chunks` docstring; the code already
  writes to unified `sources`/`chunks`.
- Added `start_ingestion_run` / `finish_ingestion_run` (unified `ingestion_runs`,
  `job_id` adoption). `write_to_db(..., job_id=None)` wraps ingest in a tracked run.
- `main()` reads `TRANSCRIPT_JSON`, `VIDEO_URL`, `VIDEO_NAME`, `JOB_ID`,
  `WRITE_DB`, `SEMANTIC` from env with CLI precedence.

Containers:
- `crawler/Dockerfile` (Playwright python base — Chromium included) and
  `transcriber/Dockerfile` (python:3.12-slim). Both fetch the RDS CA bundle at
  build time, set `DB_SSL_ROOT_CERT`, copy the shared `common/` package, run as a
  non-root user, and MUST be built from the `Project Refactoring/` directory so
  `common/db_config.py` is in the build context:
    docker build -f crawler/Dockerfile     -t kc-crawler     "Project Refactoring"
    docker build -f transcriber/Dockerfile -t kc-transcriber "Project Refactoring"

### Target AWS architecture (to build in CDK when the dev stack exists)

Web crawl (Phase 4), manual trigger at launch (decision #4):

```
Admin "Crawl" action (API Gateway, admin-authorized)
  -> proxy Lambda (small, no Chromium):
       - validate request (seed_url, max_pages, allowlist check)
       - INSERT ingestion_runs (source_id NULL, status='queued') -> job_id
       - ECS RunTask (Fargate) with env JOB_ID, SEED_URL, MAX_PAGES, WRITE_DB=true
       - return job_id
  -> ECS Fargate task (kc-crawler image):
       - crawler.py adopts JOB_ID, crawls, embeds changed chunks, upserts
         sources/chunks, updates ingestion_runs -> completed/failed
Admin dashboard polls GET ingestion_runs/{job_id} for live status.
Scheduled recrawl (later): EventBridge Scheduler -> same proxy Lambda per source.
```

Video/document ingest (Phase 5):

```
Admin uploads video + source URL (frontend) to an ingest S3 bucket
  -> S3 PutObject -> EventBridge rule -> trigger Lambda:
       - start Amazon Transcribe job (media in S3)
       - INSERT ingestion_runs (status='queued') -> job_id
  -> Transcribe completion event -> EventBridge -> embed trigger:
       - launch kc-transcriber (ECS task or container Lambda) with
         JOB_ID, TRANSCRIPT_JSON (S3 path fetched by the entrypoint), VIDEO_URL,
         VIDEO_NAME, WRITE_DB=true
       - transcrbe.py chunks with timestamps, upserts sources/chunks, updates run
```

Note: `transcrbe.py` reads `TRANSCRIPT_JSON` as a local path. In the S3 flow the
entrypoint/trigger must download the Transcribe output from S3 to a local path
first (kept out of the script to preserve local testability).

Documents (Phase 5, all-three scope): ingest via the same `sources`/`chunks`
model. Simplest path is to reuse Bedrock parsing OR a lightweight doc extractor
writing chunks directly; exact approach is an open item (section 8, item 2).

### IAM (task roles)

- Crawler/transcriber task role: `bedrock:InvokeModel` (Cohere embed),
  `rds-db:connect` (IAM auth to the DB user), and for the transcriber
  `s3:GetObject` on the transcript/output bucket. No stored DB secret (DB_AUTH=iam).
- Proxy/trigger Lambda role: `ecs:RunTask` + `iam:PassRole` (task + execution
  roles), `transcribe:StartTranscriptionJob`/`GetTranscriptionJob` (video),
  and write access to `ingestion_runs` (via the app DB user).

### Not done (needs dev stack)

- CDK constructs for the ECS cluster/task definitions, ECR repos, proxy/trigger
  Lambdas, EventBridge rules, S3 ingest bucket, and admin API routes.
- End-to-end run against the real site and a real Transcribe output.
- Admin dashboard polling UI (ties into the frontend rebuild, deferred).

---

## 15. Phase 6 — cutover & Bedrock KB / OpenSearch retirement

Status: Procedure documented. Execution requires the dev stack, a loaded pgvector
corpus, and the manual credential rotation from Phase 0. Cutover is a deliberate,
reviewed step — not run yet.

Goal (decision #1): fully retire the Bedrock Knowledge Base and OpenSearch
Serverless after pgvector proves out, to minimize cost. Keep KB briefly as a
rollback path, then remove it.

### 6.1 Preconditions before cutover
- Phase 0 credential rotation completed.
- Migration `001_unified_chunks.js` applied on the target environment; `ANALYZE
  chunks` run after the corpus is loaded.
- A representative corpus ingested via the new pipeline (web + video + document).
- `USE_PGVECTOR_RETRIEVAL` available as an env flag on the text-gen Lambda.

### 6.2 Comparison harness (validate before flipping)
Run both retrievers on the same query set and compare, since both return the same
source dict shape:
- Build a fixed query set from `user-stories/` (representative Inclusion Canada
  questions) plus a few out-of-scope probes.
- For each query, capture Bedrock KB results (`USE_PGVECTOR_RETRIEVAL=false`) and
  pgvector results (`=true`): top-k URLs, scores, and the final grounded answer.
- Metrics: retrieval overlap / expected-source hit rate, answer groundedness
  (reuse `intervention.assess_response`), p50/p95 latency, and estimated cost per
  1k queries (no OpenSearch OCU under pgvector; embed calls are the main variable).
- Acceptance thresholds are an open item (section 8, item 5) — set concrete
  numbers with stakeholders before cutover.

### 6.3 Cutover sequence
1. Deploy with `USE_PGVECTOR_RETRIEVAL=true` in a non-prod/dev environment; run the
   comparison harness; review.
2. Flip the flag in production. Keep KB infrastructure intact (rollback = set the
   flag back to false; no redeploy of infra needed).
3. Bake for an agreed window (e.g. 1-2 weeks) watching groundedness, latency, cost,
   and error rate.

### 6.4 Retirement (remove KB + OpenSearch) — exact CDK coupling
Only after the bake period. These are the concrete code touch-points found in the
current tree; remove/adjust together in one change:

- `cdk/bin/cdk.ts`
  - Remove the `KnowledgeBaseStack` import, `kbStack` instantiation, its
    `addDependency` calls, and its entry in the `stacks[]` list.
  - Remove the `vectorIndexManagerSigV4` entry from the CICD stack's
    `lambdaFunctions`/`pathFilters` (only needed to bootstrap the AOSS index).
  - Remove `knowledgeBaseBucket` / `knowledgeBaseSecret` props passed to
    `ApiGatewayStack`, and `knowledgeBaseBucketName` passed to `AmplifyStack`.
- `cdk/lib/api-stack.ts`
  - Drop `knowledgeBaseBucket` / `knowledgeBaseSecret` from `ApiGatewayStackProps`.
  - Remove `KB_SECRET_NAME` env + the `secretsmanager:GetSecretValue` grant on
    `lambdaTextGen` (retrieval no longer reads the KB id).
  - Decide the fate of the admin ingestion Lambda (`lambdaKnowledgeBase`): it
    currently uses `knowledgeBaseBucket` (presigned uploads) and `knowledgeBaseSecret`
    plus `bedrock:*IngestionJob`/`*DataSource` perms. Under pgvector this admin flow
    is REPLACED by the crawler/transcriber ingestion (proxy Lambda + ECS). Either
    repurpose this Lambda to trigger ECS RunTask / Transcribe, or remove it and add a
    new ingestion-trigger Lambda per section 14. This is the largest retirement edit
    and should be reviewed with the Phase 3/admin work.
- `cdk/lib/knowledge-base-stack.ts` — delete the stack file once nothing references it.
- `cdk/lambda/knowledgeBase/`, `cdk/lambda/knowledgeBaseProvisioner/`,
  `cdk/lambda/vectorIndexManagerSigV4/` — remove once the stack and admin flow no
  longer use them.
- `helpers/config.py` — remove `KB_ID`, `KB_SECRET_NAME`, and the KB load in
  `load_config`; drop `USE_PGVECTOR_RETRIEVAL` branch in `chat.py` (pgvector becomes
  unconditional) OR keep the flag defaulting true for one more release.
- `helpers/bedrock.py` — `retrieve_documents` can be deleted once the flag/branch is
  removed; `format_context_for_prompt` STAYS (still used by the pgvector path).

### 6.5 Data / cost cleanup
- Delete the OpenSearch Serverless collection + policies (in `knowledge-base-stack`).
  Confirm no other consumer first.
- The KB S3 source bucket: keep if still used to stage documents for the new doc
  ingestion path; otherwise remove. Decide during Phase 5 document-ingestion design.
- Remove the KB-related CloudWatch alarms/outputs.

### 6.6 Rollback
- Before retirement edits: flip `USE_PGVECTOR_RETRIEVAL=false` (instant).
- After retirement edits: rollback requires re-deploying the removed stacks, so do
  NOT delete KB infra until the bake period passes with clear success metrics.

### Not done (needs dev stack / stakeholder sign-off)
- Running the comparison harness and setting numeric acceptance thresholds.
- Executing the CDK removals above (they delete live retrieval infra).
- Repurposing vs replacing the admin ingestion Lambda (ties to Phase 3 review).

---

## 16. Phase 3 progress log — Inclusion Canada conversational behavior

Status: Code + migration complete and statically validated. Live validation
(apply migration 002, run user-story scenarios) awaits the dev stack.

### Decisions taken (confirmed)
1. Static prompt = `role` + `guardrails` + `language_guidelines`. Dropped
   `checklist` / `instructions` / `allowed_specializations` from the assembled prompt.
2. Faithful (Option A) phase prompts: detective prompt is formatted with runtime
   `exchange_count` / `min_exchanges` / `readiness_note` / `may_suggest`, and each
   phase carries its own `<output_format>`.
3. Added new `system_message_type` enum values (`language_guidelines`,
   `output_format_detective`, `output_format_suggestion`) via migration 002.
4. Updated BOTH layers — `config.py` fallbacks and the DB seed — so the app is
   correct even before the DB is re-seeded.
5. Keep `data_sources` and `sources` separate (see below).
6. Stop using `specialization_list` now; drop the column later (Phase 6 cleanup).

### Delivered
- `cdk/lambda/db_setup/migrations/002_inclusion_canada_prompts.js`
  - `pgm.noTransaction()` so `ALTER TYPE ... ADD VALUE` commits before the seed uses it.
  - Adds the three enum values; deactivates all active UBC `system_messages`;
    seeds the Inclusion Canada prompts verbatim from `textgen_v1.ipynb`
    (system_role, guardrails, language_guidelines, detective/suggestion phase
    prompts, output_format_detective/suggestion, welcome_message). Reused types
    seeded at version 2 (idempotent via `ON CONFLICT (type, version)`); new types
    at version 1. `down` removes the seeded rows and reactivates the UBC v1 rows.
- `helpers/config.py` — Inclusion Canada fallbacks for ROLE, GUARDRAILS,
  LANGUAGE_GUIDELINES, DETECTIVE/SUGGESTION phase prompts, OUTPUT_FORMAT_*,
  INITIAL_PROMPT, WELCOME_MESSAGE. Removed CHECKLIST/INSTRUCTIONS/SPEC_LIST/
  SPEC_PROMPT. `load_config` now loads the new message types and no longer reads
  `specialization_list`.
- `helpers/logic.py` — static block = role+guardrails+language_guidelines;
  detective computes `may_suggest`/`readiness_note` and `.format()`s the detective
  prompt; each phase appends its `<output_format>`; Haiku for detective, Sonnet
  for suggestion (unchanged model split).
- `helpers/chat.py` — removed the hardcoded UBC `<response_instructions>` block;
  the dynamic prompt is now `phase_instructions` + `<retrieved_context>` only, so
  the phase owns output format (including the `<answer>`/`<cited_indices>`
  contract the suggestion parser already expects — no parser change needed).

### Validation done here
- Migration node load-check passed (noTransaction called; enum + seed batches;
  all content present; down has the delete).
- `cdk> npm run build` (tsc) passes with migrations 001 + 002 and edited helpers.
- Confirmed the detective prompt (fallback and DB seed) contains exactly the four
  `.format()` placeholders, so `logic.py` formatting is safe from either source.
- Not run: live DB apply and user-story scenario validation (needs dev stack; no
  Python runtime locally).

### data_sources vs sources (Decision 5)
Kept as two distinct concerns:
- `data_sources` (from migration 000): admin-facing CONFIG — the list of things to
  ingest (a website to crawl, a video to transcribe) with name/type/patterns.
- `sources` (from migration 001): the ACTUAL ingested items (each crawled page /
  each video) that `chunks` attach to for retrieval.
- Optional future link: a nullable `data_sources.id` -> `sources` association (or a
  `data_source_id` FK on `sources`) to trace "this page came from that configured
  site." Not required for launch; revisit if the admin UI needs the linkage.

### Admin ingestion Lambda repurposing (ties to Phase 6)
The existing `lambdaKnowledgeBase` admin flow (presigned S3 uploads + Bedrock
ingestion) is REPLACED, not merely deleted, under pgvector:
- Manage `data_sources` rows (CRUD for configured sites/videos).
- Trigger ingestion by starting the crawler/transcriber (ECS RunTask / Transcribe)
  and creating the `ingestion_runs` row — i.e. it becomes the "proxy Lambda" from
  section 14.
- This is the largest remaining edit and is intentionally deferred with the Phase 6
  KB retirement so the admin API and (rebuilt) frontend can be designed together.

### Follow-ups
DONE (reworded to the Inclusion Canada inclusive-education domain):
- `chat.py` query-rewrite system prompt — now targets an inclusive-education
  knowledge base (partial day attendance, accommodations, meetings, transitions,
  advocacy, escalation) instead of a "university specialization database".
- `intervention.py` grounding verifier prompt — the three score keys
  (relevancy_score / support_score / scope_alignment_score), JSON schema, and
  labels are unchanged; only the domain wording moved from
  "specializations / courses / program details" to family situations/topics.
- `intervention.py` user-facing hallucination warnings — no longer reference
  "UBC source content" / "UBC calendar page"; now advise verifying details with
  the school or a trusted advocate.
- Verified: `cdk> npm run build` passes; zero UBC/university/specialization
  references remain in chat.py or intervention.py.

STILL OPEN (intentional):
- `crud.fetch_system_config` still SELECTs `specialization_list` — harmless and
  intentional until the Phase 6 column drop; remove together with the column.

---

## 17. R2/R3/R4 progress log — ingestion wiring + cleanup

Status: R3 and R4 complete and statically validated. R2 complete as a tsc-built
scaffold that is SYNTH-PENDING (not `cdk synth`/deploy-validated).

### R4 — drop specialization_list (done)
- `cdk/lambda/db_setup/migrations/003_drop_specialization_list.js` — `DROP COLUMN
  IF EXISTS`; `down` re-adds it nullable (UBC seed not restored).
- Removed all consumers: `crud.fetch_system_config` SELECT/mapping; `adminHandler.js`
  (GET SELECT, allowed[] list, UPDATE SET, RETURNING); frontend `SystemSettings.tsx`
  (DTO field, DEFAULT_SETTINGS, "Allowed Specializations" card + editor block, 4 state
  vars, now-unused lucide imports). Frontend build (tsc+vite) PASS; migration load-check PASS.

### R3 — pgvector ingestion trigger (done)
- New `cdk/lambda/knowledgeBase/helpers/process_crawler_batch.py`: finds latest
  `queued` website/video runs, launches one ECS Fargate task each via `ecs:RunTask`
  (container env JOB_ID / SEED_URL|VIDEO_URL / VIDEO_NAME / TRANSCRIPT_JSON /
  WRITE_DB), marks each run `running`. The container self-finalizes the run to
  completed/failed (crawler.py / transcrbe.py), so no scheduler polling is needed.
- `start_ingestion_job.py`: added `INGESTION_BACKEND` flag (default `bedrock`);
  when `pgvector`, branches to `process_crawler_batch` after promote-to-queued.
- `main.py`: `KB_SECRET_NAME` now optional; skips the KB-id fetch when
  `INGESTION_BACKEND=pgvector`. Bedrock behavior unchanged when the flag is unset.
- Reuses the existing `data_sources`/`ingestion_runs` state machine end-to-end.

### R2 — ingestion CDK scaffold (done, SYNTH-PENDING)
- New `cdk/lib/ingestion-stack.ts`: ECS cluster; task security group (egress 443 +
  5432 to VPC CIDR); S3 ingest bucket (+access logs); shared execution role; per-task
  roles (`bedrock:InvokeModel` on the Cohere embed model, `rds-db:connect` on
  `dbuser/app_rw`, DB secret read, logs; transcriber also gets ingest-bucket read);
  Fargate task defs for crawler (1024/4096) and transcriber (512/1024) from the CICD
  ECR repos with `DB_AUTH=iam` env. Helpers `grantRunTasks()` (ecs:RunTask +
  iam:PassRole) and `ingestionEnv()` (INGESTION_BACKEND + cluster/taskdef/subnet/SG
  env for lambdaKnowledgeBase).
- `cdk/bin/cdk.ts`: added `crawler` + `transcriber` to the CICD `lambdaFunctions`
  array and `pathFilters`; instantiated `IngestionStack` (deps: cicd, vpc, db); added
  to the tags list.
- Verified: `cdk> npm run build` (tsc) PASS.

### R2 caveats to resolve during the dev-stack synth review (tracked as R12)
1. api-stack integration is intentionally NOT wired to avoid coupling before synth:
   set `lambdaKnowledgeBase` env to `ingestionStack.ingestionEnv()` and call
   `ingestionStack.grantRunTasks(lambdaKnowledgeBase)`.
2. CICD buildspec builds Docker with context = `sourceDir`, but the crawler/
   transcriber Dockerfiles expect context = `Project Refactoring/` (for the shared
   `common/` package). The buildspec in `cicd-stack.ts` must be adjusted for these
   two images (or the images vendored differently).
3. `rds-db:connect` is scoped with a wildcard dbuser resource id; tighten to the
   real `dbi-resource-id` once known post-deploy.
4. The video/document ingest flow that writes `transcript_s3_uri`/`video_url` onto
   `data_sources.metadata` is assumed by `process_crawler_batch._run_transcriber_task`
   but not yet produced by an upload flow — build that with the frontend rebuild.

### Consolidated verification (this pass)
- CDK build (tsc): PASS (with IngestionStack + wiring).
- Frontend build (tsc + vite): PASS.
- Migrations 000/001/002/003 node load-check: all OK (up/down present).
- No Python runtime locally, so Python modules (process_crawler_batch, retrieval,
  config/logic/chat, crawler/transcriber) are static-reviewed only, not executed.

---

## 18. R12 progress log — ingestion wiring (code half)

Status: CODE complete and tsc-validated. The `cdk synth`/deploy half remains and
must be run on the dev stack with AWS credentials (not possible from this workspace).

Delivered:
- `api-stack.ts`: `ApiGatewayStackProps` gained an optional `ingestion` hook
  (structural: `{ ingestionEnv(), grantRunTasks(principal) }` — no hard import of
  IngestionStack, to avoid coupling). When provided, `lambdaKnowledgeBase` gets the
  ingestion env applied (INGESTION_BACKEND=pgvector + ECS cluster/taskdef/subnet/SG
  + container names) and `grantRunTasks` adds ecs:RunTask + iam:PassRole.
- `cdk.ts`: `apiStack` now receives `ingestion` wired to `ingestionStack`
  (`ingestionEnv()` / `grantRunTasks`) and declares `apiStack.addDependency(ingestionStack)`.
- `cicd-stack.ts`: `LambdaConfig` gained optional `buildContext` and `dockerfile`;
  the `docker build` command now uses them (defaults preserve existing behavior:
  context = sourceDir, dockerfile = sourceDir/Dockerfile).
- `cdk.ts`: the crawler/transcriber CICD entries set `buildContext: "Project
  Refactoring"` and the matching `dockerfile` paths, so the shared `common/` package
  is in the Docker build context. Confirmed the Dockerfiles' COPY paths
  (crawler/requirements.txt, common/, transcriber/transcrbe.py) match that context.

Verified: `cdk> npm run build` (tsc) PASS.

Remaining for R12 (AWS, owner):
- `cd cdk && cdk synth` — first real validation of the full stack graph incl.
  IngestionStack + api-stack wiring. Expect to iterate on synth-time errors.
- Deploy incrementally; confirm the crawler/transcriber images build in CodePipeline
  with the new build context; confirm lambdaKnowledgeBase receives the ingestion env.
- Only then proceed to R5–R10 (apply migrations, load corpus, validate, cutover).

---

## 19. Post-synth cleanups (ECR waiter + stale PEM)

Status: Done and `cdk synth`-validated (full app, nav-dev).

- Removed the unused committed `Project Refactoring/AmazonRootCA1.pem`. Nothing
  references it; the containers/runtime fetch the RDS CA bundle at build/run time
  via `DB_SSL_ROOT_CERT` (grep for AmazonRootCA1 = 0 matches).
- Added an ECR image waiter to `IngestionStack` (mirrors the KB stack pattern):
  a Node waiter Lambda (`lambda/ecrImageWaiter`) + IAM role (ecr:DescribeImages /
  BatchGetImage on both repos, codepipeline:StartPipelineExecution on the build
  pipeline, logs) + one `CustomResource` per repo (crawler, transcriber) with
  `TriggerBuildOnMissing=true`. The crawler/transcriber task definitions now
  `addDependency` on their waiter, so a first deploy waits for (or triggers) the
  image build instead of failing on a missing `:latest` image.
- New prop `imageBuildPipelineName` on `IngestionStackProps`, wired in cdk.ts from
  `cicdStack.pipelineName`.
- Verified: `cdk synth KC-Ingestion` and full-app synth both PASS; waiter resources
  confirmed present in cdk.out/KC-Ingestion.template.json.

This removes the most likely first-deploy failure (ECR image ordering) that was
flagged in section 17/18.

---

## 20. R9 & R10 progress log — comparison harness + retirement runbook (prepare-only)

Status: Both CODE/DOC artifacts written. Neither is executed here — R9 needs the
live stack + corpus; R10 is destructive and gated for manual operator execution.

### R9 — comparison harness (done, run on dev stack)
- `Project Refactoring/tools/compare_retrieval.py`: runs a fixed query set through
  BOTH backends, reusing the production helpers (`helpers.bedrock.retrieve_documents`,
  `helpers.retrieval.retrieve_from_pgvector`, `helpers.intervention.assess_response`,
  `format_context_for_prompt`) and the shared `common/db_config.py`. Per query it
  records retrieve/generate latency, source count, top-k URLs, cross-backend URL
  Jaccard overlap, and the assessed score+label; prints an aggregate summary and
  writes JSON. Verified all helper call signatures match the real code.
- `tools/comparison_queries.json`: 12 in-scope queries mapped to Inclusion Canada
  user-story stages (Journeys 1 & 2) + 2 out-of-scope probes.
- `tools/README.md`: prereqs, run commands, and how to read results into thresholds.
- To run (from an env with AWS creds + DB access):
  `python compare_retrieval.py --backends both --top-k 7 --min-score 0.40`
  (needs `KB_ID`, `REGION`, and DB env). Then record accepted thresholds in §8 item 5.

### R10 — retirement runbook (done, execute manually)
- `Project Refactoring/RETIREMENT.md`: a gated, DESTRUCTIVE, ordered runbook that
  makes §6.4 concrete. Sections: §0 preconditions; §1 reversible flag flip (the real
  cutover, no infra deletion); §2 exact code edits (cdk.ts / api-stack / delete
  knowledge-base-stack / remove Bedrock-only lambdas & KB config, KEEP
  `format_context_for_prompt`); §3 deploy order (Api before destroy); §4
  `cdk destroy KC-KnowledgeBase` + OpenSearch/S3/ECR cleanup; §5 rollback (instant
  before §4, slow/lossy after); §6 verification. Marked DO-NOT-AUTO-RUN.

### What remains (live AWS / owner)
- R1 credential rotation; bootstrap + incremental deploy; R5–R8 (apply migrations,
  load corpus, live-validate behind the flag); R9 run + thresholds; R10 execute.
- All code/design/docs achievable in this workspace are now complete.
