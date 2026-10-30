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
  common/            Shared helpers: db_config.py, embeddings.py, url_safety.py
  crawler/           Web crawler pipeline (Playwright → chunking → pgvector)
  transcriber/       Video transcript pipeline (Transcribe JSON → chunking → pgvector)
  tests/             Unit tests, run in the pipeline's test stage
```

`crawler/` and `transcriber/` both import `common/` as a sibling package, so their Dockerfiles build with `cdk/containers` as the build
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
Crawls one website per task (same-domain links, up to 50 pages), extracts
article content, chunks it at headings, and embeds it into pgvector.

See [`crawler/README.md`](crawler/README.md) for full technical detail.

```
Admin adds a website, then clicks Sync now
    → lambdaKnowledgeBase marks the ingestion_runs row running and calls
      ecs:RunTask with JOB_ID + SEED_URL (process_crawler_batch.py)
    → ECS Fargate runs crawler.py (Playwright + Chromium)
    → crawler.py marks the run completed or failed
    → if the task dies first, the ECS task-stopped event fails the run
```

### 2. Video Transcription
Admin uploads a video or audio file → Amazon Transcribe converts it to a
structured JSON → the ingestor chunks it by sentence segment and embeds into
pgvector with timestamps for deep-linking.

See [`transcriber/README.md`](transcriber/README.md) for full technical detail.

```
Admin uploads the file (presigned URL) and stages it with a public video_url
    → lambdaKnowledgeBase starts an Amazon Transcribe job (video_transcription.py)
    → Transcribe completion event → EventBridge → transcribeRelay
    → lambdaKnowledgeBase launches the transcriber task with the transcript location
    → transcrbe.py marks the run completed or failed
```

Both tasks read the embedding model from the active embedding space, connect
through RDS Proxy with the database secret (`DB_AUTH=secret`, set on every
`RunTask`), and write vectors to `chunk_embeddings`.

---

## Database Schema

Migrations live in `cdk/lambda/db_setup/migrations/`. The relevant ones for
this pipeline:

| Migration | Tables Added / Changed | Purpose |
|---|---|---|
| `000_initial_schema.js` | users, chat_*, system_*, data_sources, ingestion_runs | Base app schema (+ `vector` extension) |
| `001_unified_chunks.js` | `sources`, `chunks`; extends `ingestion_runs` | Unified pgvector retrieval corpus + unified ingestion-run model |

**`sources` table:** one row per ingested source.
- `source_type`: `'web'` or `'video'` from these pipelines (`'document'`, `'csv_link'` and `'csv_row'` come from the knowledge base Lambda)
- `url`: canonical URL (web page URL or YouTube link)

**`chunks` table:** one row per embedded text chunk.
- `embedding vector(1024)`: legacy column, no longer written by the ingestion containers (kept until the cleanup migration). Vectors live in `chunk_embeddings`, one row per (chunk, embedding space), written by the crawler and transcriber for the ACTIVE space only. The model, dimension, batch size and `split_threshold` come from the database (`embedding_active_space` / `embedding_spaces`), not from the ECS task definition; `EMBED_MODEL_ID` / `EMBED_BATCH_SIZE` are deprecated fallbacks for standalone crawl-only runs without database access
- `metadata jsonb`: type-specific fields — web: `{"heading_path": "..."}`, video: `{"chunk_start": "HH:MM:SS", "chunk_end": "HH:MM:SS"}`
- `content_hash`: sha256 first 16 hex chars of body — used for change detection on re-ingest

---

## Retrieval in Production

`cdk/lambda/textGeneration/helpers/retrieval.py` embeds the query with the
active space's model and runs the shared similarity search in
`cdk/layers/shared_python/python/kc_shared/retrieval_core.py` against
`chunk_embeddings`, `chunks` and `sources`. See
[`Docs/KNOWLEDGE_BASE_DOCUMENTATION.md`](../../Docs/KNOWLEDGE_BASE_DOCUMENTATION.md).

`common/embeddings.py` is a copy of the layer's `kc_shared/embeddings.py`
(containers cannot use a Lambda layer), and `common/url_safety.py` mirrors the
knowledge base Lambda's `helpers/url_safety.py`. The parity tests fail if
either drifts.

## See Also

- [`crawler/README.md`](crawler/README.md) — web crawler pipeline
- [`transcriber/README.md`](transcriber/README.md) — video transcription pipeline
- [`Docs/KNOWLEDGE_BASE_DOCUMENTATION.md`](../../Docs/KNOWLEDGE_BASE_DOCUMENTATION.md) — ingestion end to end
- [`Docs/PGVECTOR_MIGRATION_PLAN.md`](../../Docs/PGVECTOR_MIGRATION_PLAN.md) — the original migration plan and decision log (historical)
- [`Docs/user-stories/`](../../Docs/user-stories/) — user stories and prompt design
- `cdk/lambda/textGeneration/helpers/` — production Lambda helpers that consume this pipeline's data
