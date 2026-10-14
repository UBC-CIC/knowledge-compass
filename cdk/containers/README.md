# cdk/containers

Container image sources for the pgvector ingestion pipeline. These are built by
the CICD pipeline (`cdk/lib/cicd-stack.ts`, wired from `cdk/bin/cdk.ts`) into
ECR images and run as ECS Fargate tasks (`cdk/lib/ingestion-stack.ts`).

Knowledge Compass is a RAG-powered conversational assistant for Inclusion
Canada, helping families navigate inclusive education in Canada. Retrieval is
backed by a unified `sources` + `chunks` pgvector schema, so a single query
covers both web content and video transcripts.

---

## Directory Structure

```
cdk/containers/
  common/            Shared, secret-free DB/AWS config helper (db_config.py)
  crawler/           Web crawler pipeline (Playwright → chunking → pgvector)
  transcriber/       Video transcript pipeline (Transcribe JSON → chunking → pgvector)
  tools/             compare_retrieval.py — live retrieval comparison harness (R9)
```

`crawler/` and `transcriber/` both import `common/db_config.py` as a sibling
package, so their Dockerfiles build with `cdk/containers` as the build
context — see the `docker build` command at the top of each Dockerfile.

---

## Testing Environment

A live testing environment exists on **Amazon SageMaker** in the JupyterLab
instance named **`web-crawler-demo-2`** (ca-central-1). This instance is in
the same VPC as the RDS database and has the necessary IAM permissions for
Bedrock and RDS IAM auth.

> **This is for testing only — not production.** Scripts are run manually
> from the JupyterLab terminal here to validate the pipeline end to end.

**To use it:**
1. Open the instance in the AWS Console → SageMaker → Notebook Instances → `web-crawler-demo-2`
2. Open JupyterLab → Terminal
3. Create a conda environment and install dependencies:
   ```bash
   source /home/ec2-user/anaconda3/bin/activate kc   # if env already exists
   # or create fresh:
   conda create -n kc python=3.11 -y
   source /home/ec2-user/anaconda3/bin/activate kc
   ```
4. Copy the script you want to test (`crawler.py`, `transcrbe.py`) into the SageMaker home directory (`/home/ec2-user/SageMaker/`)
5. Install dependencies for that script and run it

**You do not need to replicate this repo's directory structure on SageMaker.**
Just copy the individual script files you need — the SageMaker instance is a
scratch environment for running and validating scripts, not a mirror of the
repo.

---

## Two Data Pipelines

### 1. Web Crawler
Crawls Inclusion Canada's website, extracts article content, chunks it
semantically, and embeds it into pgvector.

See [`crawler/README.md`](crawler/README.md) for full technical detail.

```
Admin triggers crawl
    → Lambda (proxy): inserts crawl job row in DB (status=queued), returns job_id
    → Lambda starts ECS Fargate task with job_id + seed_url
    → ECS Fargate runs crawler.py (Playwright + Chromium)
    → On completion: ECS updates job row status → admin sees result in dashboard
Automation: EventBridge cron rule → same Lambda, no frontend interaction needed
```

### 2. Video Transcription
Admin uploads a video file → Amazon Transcribe converts it to a structured
JSON → the ingestor chunks it by speaker segment and embeds into pgvector
with timestamps for deep-linking.

See [`transcriber/README.md`](transcriber/README.md) for full technical detail.

```
Admin uploads video to S3 + provides source URL
    → S3 PutObject event → EventBridge rule
    → Lambda: starts Transcribe job, inserts ingestion job row in DB
    → Transcribe completion event → EventBridge
    → Lambda: runs transcrbe.py logic, updates job row status
```

---

## Database Schema

Migrations live in `cdk/lambda/db_setup/migrations/`. The relevant ones for
this pipeline:

| Migration | Tables Added / Changed | Purpose |
|---|---|---|
| `000_initial_schema.js` | users, chat_*, system_*, data_sources, ingestion_runs | Base app schema (+ `vector` extension) |
| `001_unified_chunks.js` | `sources`, `chunks`; extends `ingestion_runs` | Unified pgvector retrieval corpus + unified ingestion-run model |

**`sources` table:** one row per ingested source (web page or video).
- `source_type`: `'web'` or `'video'`
- `url`: canonical URL (web page URL or YouTube link)

**`chunks` table:** one row per embedded text chunk.
- `embedding vector(1024)`: legacy column, no longer written by the ingestion containers (kept until the cleanup migration). Vectors live in `chunk_embeddings`, one row per (chunk, embedding space), written by the crawler and transcriber for the ACTIVE space only. The model, dimension, batch size and `split_threshold` come from the database (`embedding_active_space` / `embedding_spaces`), not from the ECS task definition; `EMBED_MODEL_ID` / `EMBED_BATCH_SIZE` are deprecated fallbacks for standalone crawl-only runs without database access
- `metadata jsonb`: type-specific fields — web: `{"heading_path": "..."}`, video: `{"chunk_start": "HH:MM:SS", "chunk_end": "HH:MM:SS"}`
- `content_hash`: sha256 first 16 hex chars of body — used for change detection on re-ingest

---

## Retrieval in Production

`cdk/lambda/textGeneration/helpers/retrieval.py` runs the pgvector cosine
similarity query against `chunks` + `sources` that these pipelines feed.
`cdk/containers/tools/compare_retrieval.py` is the live harness (R9) used to
compare that retrieval path against the retired Bedrock Knowledge Base
backend before cutover.

## See Also

- [`crawler/README.md`](crawler/README.md) — web crawler pipeline
- [`transcriber/README.md`](transcriber/README.md) — video transcription pipeline
- [`tools/README.md`](tools/README.md) — retrieval comparison harness
- [`Docs/PGVECTOR_MIGRATION_PLAN.md`](../../Docs/PGVECTOR_MIGRATION_PLAN.md) — the original migration plan and decision log
- [`Docs/RETIREMENT_RUNBOOK.md`](../../Docs/RETIREMENT_RUNBOOK.md) — Bedrock KB / OpenSearch retirement runbook
- [`Docs/user-stories/`](../../Docs/user-stories/) — user stories and prompt design
- `cdk/lambda/textGeneration/helpers/` — production Lambda helpers that consume this pipeline's data
