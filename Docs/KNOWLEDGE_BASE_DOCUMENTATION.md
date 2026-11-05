# Knowledge Base

How content gets into the Knowledge Compass knowledge base and how it is searched: the admin routes, how each kind of data source is staged and ingested, the ingestion-run state machine, embedding spaces, and how to debug a source that will not ingest.

Everything is stored in PostgreSQL with **pgvector**: source text, chunks, and one vector per chunk per embedding space. There is no Bedrock Knowledge Base or OpenSearch collection; those were retired (see the historical [migration plan](./PGVECTOR_MIGRATION_PLAN.md)).

## Table of Contents

- [Knowledge Base](#knowledge-base)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Components](#components)
  - [Admin Routes](#admin-routes)
  - [Uploads](#uploads)
  - [Data Source Types](#data-source-types)
  - [Ingestion Runs and Sync](#ingestion-runs-and-sync)
  - [Ingestion Paths](#ingestion-paths)
    - [Websites](#websites)
    - [Videos](#videos)
    - [CSV, Markdown and documents](#csv-markdown-and-documents)
    - [CSV row resources and linked content](#csv-row-resources-and-linked-content)
      - [Storage and chunk layout](#storage-and-chunk-layout)
      - [Citation and status semantics](#citation-and-status-semantics)
    - [PDF text extraction](#pdf-text-extraction)
  - [Retry and Delete](#retry-and-delete)
  - [Embedding Spaces](#embedding-spaces)
  - [Retrieval](#retrieval)
  - [Monitoring and Debugging](#monitoring-and-debugging)
    - [Logs](#logs)
    - [Useful metadata](#useful-metadata)
    - [Common questions](#common-questions)
  - [Configuration](#configuration)
  - [Glossary](#glossary)

## Overview

Two tables describe what an administrator added and where it is in its lifecycle:

* `data_sources` — *what* to ingest: a website, an uploaded file, or a video
* `ingestion_runs` — *where it is*: one row per attempt, with a `status`

Ingestion writes three tables that retrieval reads:

* `sources` — one row per retrievable source (a crawled page, a video, a document, a CSV row or a page it links to)
* `chunks` — the chunk text and metadata for each source
* `chunk_embeddings` — one vector per chunk in each embedding space

The normal flow:

```text
Admin uploads a file (presigned S3 PUT) or enters a website URL
        ↓
POST /admin/data_sources stages it: data_sources row + pending ingestion run
        ↓
Documents start right away; a video starts an Amazon Transcribe job
        ↓
Admin clicks Sync now: pending runs become queued, then running
        ↓
Website → crawler ECS task      Video (transcribed) → transcriber ECS task
CSV / Markdown → document worker (async self-invocation of the Lambda)
        ↓
The worker chunks, embeds with the active embedding model, writes
sources/chunks/chunk_embeddings, and marks its run completed or failed
```

## Components

| Component | Location | Role |
| --- | --- | --- |
| Knowledge base Lambda | `cdk/lambda/knowledgeBase/main.py` | Admin routes, async workers (documents, CSV links, guideline documents, embedding jobs), and the Transcribe and ECS events forwarded by the relay |
| Shared layer | `cdk/layers/shared_python/python/kc_shared/` | CORS, embeddings, retrieval core and eval scoring, shared with text generation |
| Crawler | `cdk/containers/crawler/` | ECS Fargate task: Playwright crawl of one website, chunk, embed, write |
| Transcriber | `cdk/containers/transcriber/` | ECS Fargate task: chunk a Transcribe output by timestamp, embed, write |
| Transcribe relay | `cdk/lambda/transcribeRelay/` | Forwards Transcribe job and ECS task-stopped events from EventBridge to the knowledge base Lambda |
| Ingest bucket | `cdk/lib/ingestion-stack.ts` | Uploads, Transcribe outputs, Textract staging and cache |

The knowledge base Lambda has 1024 MiB and a 600-second timeout; long work runs in async self-invocations that continue themselves when they run low on time. Every self-invocation carries a token from Secrets Manager (`helpers/worker_envelope.py`) that only this function's role can read, so permission to invoke the function is not enough to run a worker.

Main helper modules (`cdk/lambda/knowledgeBase/helpers/`):

| File | Responsibility |
| --- | --- |
| `generate_presigned_url.py`, `generate_presigned_urls_batch.py` | Presigned S3 PUT URLs, recorded per admin in `upload_issuances` |
| `stage_data_sources.py`, `stage_data_sources_batch.py` | Validate and stage websites, CSV/Markdown pairs, documents and videos |
| `start_ingestion_job.py` | Sync now: promote pending runs to queued and launch them |
| `process_crawler_batch.py` | Launch crawler and transcriber ECS tasks; fail runs whose task stops early |
| `process_document_batch.py` | Chunk and embed CSV, Markdown and documents |
| `csv_links.py`, `process_csv_links.py`, `link_fetcher.py` | Fetch and index the pages a CSV's rows link to |
| `pdf_text.py` | PDF text through Amazon Textract with a pypdf fallback |
| `video_transcription.py` | Start Transcribe jobs and handle their completion |
| `retry_ingestion_run.py`, `delete_data_source.py`, `data_source_cleanup.py`, `web_sources.py` | Retry and delete |
| `embedding_admin.py`, `embedding_jobs.py`, `reembed_space.py`, `validate_space.py`, `cutover.py`, `ingestion_lock.py` | Embedding spaces and the cutover lock |
| `guideline_admin.py`, `guideline_document.py`, `guideline_extract.py` | Journey guideline documents |
| `url_safety.py` | Public-URL checks for websites and fetched links (mirrored in `cdk/containers/common/`) |
| `admin_audit.py` | Records privileged actions in `admin_audit` |

## Admin Routes

Every route is under `/admin` behind the admin authorizer, and `main.py` refuses any request whose authorizer role is not `admin`. `GET /admin/data_sources` is served by `adminHandler.js`; the rest by this Lambda. The routes are listed in [API_DOCUMENTATION.md, Knowledge Base / Data Sources](./API_DOCUMENTATION.md#knowledge-base--data-sources).

The request identity (`created_by`, audit actor) always comes from the authorizer context, never from the request body. Any route that can start ingestion answers `409 CUTOVER_LOCKED` while an embedding-space cutover runs.

## Uploads

The dashboard asks for a presigned URL, uploads the file directly to the ingest bucket with HTTP `PUT`, then stages it. Generating a URL records an `upload_issuances` row binding the S3 key to the requesting admin; staging claims that row once, so one administrator cannot stage another's upload.

| Prefix | Files | URL lifetime |
| --- | --- | --- |
| `uploads/csv` | CSV | 300 s |
| `uploads/markdown` | Markdown | 300 s |
| `uploads/json` | Metadata JSON | 300 s |
| `uploads/document` | PDF, DOCX, TXT | 3600 s |
| `uploads/video` | Video and audio (mp4, m4v, webm, mp3, m4a, wav, flac, ogg, amr) | 3600 s |
| `uploads/files` | Anything else | 300 s |

Batch URLs (`POST /admin/generate-presigned-urls/batch`) last 600 s and accept CSV, Markdown, JSON and `application/octet-stream` only.

Keys have the form `{prefix}/{timestamp}_{random}_{file_name}`. Uploading a file again under the same name replaces that data source in place, and only chunks whose text changed are re-embedded.

## Data Source Types

| `type` | Staged with | Ingested by | Starts |
| --- | --- | --- | --- |
| `website` | `name` (seed URL), optional `include_patterns` / `exclude_patterns` | Crawler ECS task | On Sync now |
| `csv` | CSV file + `{file}.metadata.json`, optional row-resource columns | Document worker, then the CSV link phase if `url_column` is set | On Sync now |
| `markdown` | Markdown file + `{file}.metadata.json` | Document worker | On Sync now |
| `document` | PDF, DOCX or TXT file + `document_url` (required public link used as the citation) | Document worker | Immediately on staging |
| `video` | Video or audio file + `video_url` (required public link used for citations and timestamp deep links) | Amazon Transcribe, then the transcriber ECS task | Transcription immediately; the transcriber when Transcribe finishes |

Rules worth knowing:

* **Websites.** The seed URL must be a public http(s) URL; it is checked when staged, again before the task launches, and in the container before crawling (see [URL safety](../cdk/containers/crawler/README.md)). The crawler follows same-domain links up to 50 pages. `include_patterns` and `exclude_patterns` are stored and shown in the dashboard but are **not** currently passed to the crawler, so they have no effect on what is crawled. Each crawled page becomes its own `sources` row, linked to its website through `web_source_owners`.
* **CSV and Markdown** need a companion metadata file named exactly `{primary_file_name}.metadata.json`. The metadata file has no content of its own: its run completes immediately and its JSON is attached to the primary source's metadata. The dashboard shows it as a child row of its file.
* **Markdown** is split into sections by heading, then into ~300-word chunks with sentence overlap. **CSV** rows are rendered as `column: value` lines and grouped into ~175-word chunks of whole rows, with content-defined boundaries so editing one row only changes the chunks around it.
* **Documents** are split into ~300-word chunks with sentence overlap; PDFs are read as described in [PDF text extraction](#pdf-text-extraction). Uploads are never served to public users, so the citation is always `document_url`.
* **Videos** are chunked by Transcribe's sentence segments, with each chunk's start and end time stored for deep links. A `video_url` already used by a crawled page or another source is rejected.

## Ingestion Runs and Sync

`ingestion_runs.status` is the state machine:

| Status | Meaning |
| --- | --- |
| `pending` | Staged, or re-queued by a retry; waiting for Sync now |
| `queued` | Selected by a Sync now and about to launch |
| `running` | An ECS task or the document worker owns the run |
| `completed` | The worker finished and committed its chunks |
| `failed` | The worker, the launch, or the task failed; `error_message` says why |

**Sync now** (`POST /admin/data_sources/sync`, `start_ingestion_job.py`):

1. Creates a `sync_session_id` and promotes the latest `pending` run of each data source to `queued`. A video whose transcription has not completed is skipped; it is launched when Transcribe finishes.
2. Launches the queued work: one crawler task per website (`process_crawler_batch.py`) and one async document-worker invocation for the CSV, Markdown and JSON runs (`trigger_document_batch`). Each launched run is marked `running`.
3. Returns `200` if anything started, otherwise `409`.

Each worker finalizes its own run as `completed` or `failed`; nothing polls. Safety nets for runs that would otherwise stay `running`:

* An ECS task that stops without updating its run (crash, out of memory) is reported by EventBridge through the relay, and `handle_ecs_task_stopped` fails the run with the stop reason and exit codes.
* The document worker hands remaining runs to a fresh invocation when it runs low on time, up to a fixed number of continuations.
* A CloudWatch alarm fires when an async invocation of the knowledge base Lambda is dropped.

## Ingestion Paths

### Websites

The crawler task receives `JOB_ID` (the run), `SEED_URL`, and database settings (`DB_AUTH=secret`). It renders pages with Playwright, extracts the main text with trafilatura, chunks at headings, embeds with the active embedding space's model, and writes through RDS Proxy. Unchanged chunks (same content hash) are not re-embedded. See [`cdk/containers/crawler/README.md`](../cdk/containers/crawler/README.md).

### Videos

1. Staging starts an Amazon Transcribe job on the uploaded file, writing its JSON to `transcripts/` in the ingest bucket.
2. When the job finishes, EventBridge invokes the relay, which forwards the event to the knowledge base Lambda (`handle_transcribe_complete`). A failed job fails the run.
3. On success the Lambda launches the transcriber task with the transcript location, `VIDEO_URL` and the run id, unless a cutover is in progress, in which case the run goes back to `pending` for the next Sync now.

See [`cdk/containers/transcriber/README.md`](../cdk/containers/transcriber/README.md).

### CSV, Markdown and documents

`process_document_batch.py` runs as an async self-invocation (`"task": "process_document_batch"`), so it is not bound by API Gateway's 29-second limit. Re-ingesting a source moves chunks whose text is unchanged, with their stored vectors, instead of embedding them again. A CSV with `url_column` is then handed to the link phase, described next.

### CSV row resources and linked content

A CSV opts in to discrete row resources by configuring `url_column`. The CSV's original whole-file, content-defined chunks remain indexed exactly as before; row resources supplement rather than replace them. Once configured, **every row** is planned, including rows whose fetch URL cell is blank or invalid.

| Field | Description |
| --- | --- |
| `url_column` | Feature gate and the single HTML/PDF URL to fetch for each row. A blank cell does not prevent row-only indexing. |
| `row_id_column` | Optional stable identity across re-uploads. Without it, the normalized full row determines identity. |
| `title_column` | Optional human title used for the row source and fetched content. |
| `description_column` | Optional description included in row text and prepended to each row-specific fetched chunk. |
| `citation_column` | Optional public URL shown to users. It is independent of the URL that was fetched. |

All configured roles require `url_column` and are resolved against the CSV header exactly, then case-insensitively after trimming. Exact header spelling is stored in `data_sources.metadata`. Mapping-only changes trigger reprocessing even when file bytes are unchanged. Without `url_column`, staging still returns `suggested_url_column` when more than 80% of sampled non-empty values in a column are safe HTTP(S) URLs, but no row-resource work runs.

#### Storage and chunk layout

- The uploaded CSV stays a `document` source with its grouped whole-row chunks.
- Each normalized fetch URL has one canonical `csvlink://<normalized-url>` source, fetched once per CSV and sync, and hidden from answer retrieval once row variants exist.
- Each row owns a private `csvrow://<data-source-id>/<row-key-hash>` source (`source_type = 'csv_row'`). Chunk `0` holds the row's descriptive columns (not the fetch URL, citation URL or stable ID); chunks `1+` are the canonical fetched chunks with the row description prepended. Row-only chunks may be shorter than the normal 20-word minimum.

Rows that share a page share one fetch but each get their own copies of its chunks, so storage grows with rows × chunks per page.

#### Citation and status semantics

Citation resolution is row-local:

1. A valid HTTP(S) value from `citation_column`.
2. Otherwise, the normalized `url_column` value.
3. Otherwise, no public URL; the user sees a titled, non-clickable resource card.

An invalid non-empty citation value records `citation_warning` and safely follows the fallback chain. Valid citation fragments (for example `#page=12` or a section anchor) are preserved even though fragments are removed from fetch identity. Internal `csvrow://` identities are never exposed. Retrieval prefers chunk citation metadata, then source citation metadata, requires the owning row to be currently indexed, and pages past competing variants of the same canonical fetched chunk before final top-k selection.

`csv_row_links.status` continues to describe fetching: `pending`, `success`, `failed`, or `skipped`. A blank URL is `skipped` with reason `no fetch URL`; invalid/failing URLs remain `failed`. Independent fields report row-resource indexing: `row_indexed`, `fetched_content_indexed`, `indexing_reason`, and `indexed_at`. A fetch failure does not remove chunk `0`; permanent failures remove stale fetched chunks while transient failures preserve previously indexed fetched content.

The background worker indexes row-only resources in bounded batches, fetches each distinct URL with the existing safe HTTP client, materializes bounded sets of row variants, and uses continuations for remaining fetch or indexing work. Reconciliation preserves a stable row source when `row_key` survives and deletes orphaned row/canonical sources when rows or CSV data sources disappear.

Per-row fetch and indexing state is available from `GET /admin/data_sources/{id}/links?status=&limit=&offset=`. The response preserves existing fields and adds configured roles, title/description, raw/resolved citation, citation warnings, and indexing diagnostics. The run metadata continues to receive `link_summary` or `link_error`.

Limits (environment variables on the knowledge base Lambda):

| Variable                        | Default  | Meaning                                                                  |
| ------------------------------- | -------- | ------------------------------------------------------------------------ |
| `LINK_MAX_URLS_PER_CSV`         | 500      | Distinct URLs crawled per CSV; rows past the cap are `skipped`.           |
| `LINK_REQUEST_TIMEOUT_SECONDS`  | 15       | Per connect/read.                                                        |
| `LINK_TOTAL_TIMEOUT_SECONDS`    | 90       | Whole fetch of one URL, redirects included.                              |
| `LINK_MAX_CONTENT_BYTES`        | 52428800 | Largest page/PDF (after decompression), 50 MB, same as uploads.          |
| `LINK_MAX_REDIRECTS`            | 5        |                                                                          |
| `LINK_CONCURRENCY`              | 8        | Parallel fetches per worker.                                             |
| `LINK_PER_DOMAIN_CONCURRENCY`   | 2        | Parallel requests to one host.                                           |
| `LINK_PER_DOMAIN_DELAY_SECONDS` | 1        | Minimum gap between requests to one host (a larger robots delay wins).   |
| `LINK_MAX_CRAWL_DELAY_SECONDS`  | 10       | Cap on a robots.txt `Crawl-delay`.                                       |
| `LINK_MAX_CONTINUATIONS`        | 20       | Times the worker re-invokes itself when out of time before giving up.    |

### PDF text extraction

Uploaded PDF documents and PDFs linked from CSV rows are read by `helpers/pdf_text.py`. Amazon Textract document analysis with the `LAYOUT` feature OCRs scanned and image-only pages, returns paragraphs in reading order across columns, and drops running headers, footers, and page numbers. pypdf's embedded text layer is the fallback, so a PDF that indexed before Textract still indexes when Textract is unavailable.

`PDF_TEXTRACT_MODE` on the knowledge base Lambda (set in `cdk/lib/api-stack.ts`) controls when Textract runs:

| Value | Behavior |
| --- | --- |
| `always` (default) | Every PDF is read with Textract. |
| `auto` | Only PDFs whose embedded text is missing or unreadable on at least a quarter of their pages (under 20 words, or mostly non-letter characters). |
| `off` | pypdf only, as before Textract was added. |

How a PDF is read:

* Single-page PDFs up to 10 MB use the synchronous `AnalyzeDocument` API. Anything else runs as an asynchronous `StartDocumentAnalysis` job: uploads are read in place, and fetched PDFs are first copied to `textract/input/` in the ingest bucket.
* OCR waits are budgeted against the Lambda's remaining time, keeping 90 seconds for chunking, embedding, and database writes. An upload whose job is still running is handed to a fresh invocation of the document worker (up to 10 continuations). A linked PDF falls back to its embedded text; if it has none, its rows fail with a transient reason and keep previously indexed content.
* Unfinished jobs are recorded under `textract/jobs/` by content hash, so a continuation, a retry, or the next sync picks up a running job instead of paying for a new one. Textract keeps async results for 7 days.
* Finished results are cached under `textract/cache/` by content hash, so re-syncing an unchanged PDF does not run OCR again.
* Files over Textract's limits (500 MB or 3,000 pages) skip Textract. Pages missing from a partially successful job use their embedded text.

Everything under `textract/` expires after 30 days (lifecycle rule `ExpireTextractArtifacts` in `cdk/lib/ingestion-stack.ts`), so cached text of a deleted document can remain for up to that long.

Each PDF document run records `ingestion_runs.metadata.pdf_extraction`: `engine` (`textract` or `pypdf`), `pages`, `characters`, `seconds`, and where relevant `cached`, `textract_job_id`, and a `note` explaining a fallback. It never contains document text. When a PDF yields no text, the run's `error_message` (or the CSV row's reason) says what was tried, for example `no extractable text (OCR found none)`, and suggests a retry when the cause was transient.

Textract bills per page analyzed (see [Amazon Textract pricing](https://aws.amazon.com/textract/pricing/)). The cache avoids repeat charges for unchanged PDFs, and `auto` limits OCR to the PDFs that need it. Default request quotas are low outside the largest regions (for example 2 `StartDocumentAnalysis` and 1 `AnalyzeDocument` request per second), so the client retries throttled calls adaptively and large CSV link crawls slow down rather than fail.

The knowledge base Lambda's own role (`knowledgeBaseRole`) is granted `textract:AnalyzeDocument`, `textract:StartDocumentAnalysis`, and `textract:GetDocumentAnalysis`. Textract reads S3 objects with the caller's own permissions, so no Textract service role is needed. No database migration is required.

## Retry and Delete

**Retry** (`POST /admin/data_sources/{id}/retry`) only accepts a source whose latest run is `failed`. It inserts a new `pending` run (`metadata.action = "manual_retry"`, `retry_of_ingestion_run_id` pointing at the failed run) and leaves the failed run as history. The admin then clicks Sync now. The dashboard shows only the latest run of each source.

**Delete** (`DELETE /admin/data_sources/{id}`) removes the data source, its chunks and vectors (for a website, the pages it crawled that no other website also owns), and its S3 objects, and records the action in `admin_audit`. Deleting a CSV removes its row resources; a linked page is deleted once no row references it.

## Embedding Spaces

An embedding space is one model + dimension. Vectors live in `chunk_embeddings` per space, and `embedding_active_space` names the space that retrieval reads and ingestion writes. New installs start on Amazon Titan Text Embeddings V2 (`titan-v2-1024`); deployments created before migration 049 stay on Cohere Embed English v3 until an administrator switches.

From the admin dashboard (**Search index**) an administrator can create a space for another model, dry-run and rebuild it next to the live one, validate it against the golden question set, then activate it. Activation sets the cutover lock, waits for in-flight ingestion to finish, embeds anything still missing, revalidates, flips the pointer, and releases the lock. Rollback flips back to a retired space; purge deletes a retired space's vectors. Jobs persist their progress in `embedding_jobs`, so a crashed invocation resumes.

The full procedure is in the [embedding model swap runbook](./runbooks/embedding-model-swap.md).

## Retrieval

Text generation embeds the router's rewritten query with the active space's model and runs the similarity search in `kc_shared/retrieval_core.py`, which space validation also uses, so both run the same SQL. Each space has its own partial HNSW index, and a vector only counts if it was computed from the chunk's current text. Results are de-duplicated, filtered by the space's `min_score` when one is set, and passed to the model marked as untrusted data. Only guidance turns retrieve; clarifying (detective) turns do not.

## Monitoring and Debugging

### Logs

| Log group | What to look for |
| --- | --- |
| `/aws/lambda/<prefix>-Api-lambdaKnowledgeBase` | Staging, Sync now, worker progress, Transcribe and ECS events |
| Crawler and transcriber ECS log streams (prefixes `crawler` and `transcriber`) | Per-page crawl and transcript processing |
| `/aws/lambda/<prefix>-Ingestion-transcribeRelay` | Events forwarded to the knowledge base Lambda |

Logs never contain document text, queries or request bodies; only ids, counts and statuses.

### Useful metadata

| Field | Where | Meaning |
| --- | --- | --- |
| `sync_session_id` | `ingestion_runs.metadata` | Which Sync now launched the run |
| `action`, `retry_of_ingestion_run_id` | `ingestion_runs.metadata` | Manual retry history |
| `pdf_extraction` | `ingestion_runs.metadata` | How a PDF was read |
| `link_summary`, `link_error` | `ingestion_runs.metadata` | CSV link phase outcome |
| `transcribe_job_name`, `transcribe_status` | `data_sources.metadata` | Video transcription state |

### Common questions

**A source is stuck in `pending`.** Staging does not start websites, CSVs or Markdown; click Sync now. A video stays pending until its transcription completes. A run deferred by a cutover returns to pending.

**Sync now returns 409.** Nothing was pending, or a cutover is in progress (`CUTOVER_LOCKED`).

**A source is stuck in `running`.** Check the ECS task in the cluster and its log stream. If the task stopped, the ECS event should have failed the run; check the relay's logs. For documents, check the knowledge base Lambda logs for the worker's continuations.

**A website indexed fewer pages than expected.** The crawler stops at 50 same-domain pages and skips non-public addresses. Include/exclude patterns are not applied.

**Answers do not use new content.** Confirm the run is `completed` and that the content was embedded in the active space (**Search index** shows coverage per space).

## Configuration

Set on the knowledge base Lambda in `cdk/lib/api-stack.ts` (and `ingestionEnv()` in `cdk/lib/ingestion-stack.ts`):

| Variable | Meaning |
| --- | --- |
| `KNOWLEDGE_BASE_BUCKET_NAME` | The ingest bucket |
| `ECS_CLUSTER_ARN`, `CRAWLER_TASK_DEF_ARN`, `TRANSCRIBER_TASK_DEF_ARN` | Where crawler and transcriber tasks run |
| `INGESTION_SUBNET_IDS`, `INGESTION_SECURITY_GROUP_IDS` | Task networking |
| `TRANSCRIBE_DATA_ACCESS_ROLE_ARN`, `TRANSCRIBE_OUTPUT_PREFIX` | Amazon Transcribe output |
| `WORKER_INVOKE_SECRET_ARN` | Token that authenticates async self-invocations |
| `PDF_TEXTRACT_MODE` | `always` (default), `auto` or `off` |
| `LINK_*` | CSV link-fetch limits (see [CSV row resources](#csv-row-resources-and-linked-content)) |
| `HAIKU_ARN`, `LLM_REGION` | Model used to label guideline document sections |

## Glossary

* **Data source:** A row in `data_sources`: a website, CSV, Markdown file, metadata JSON, document or video an administrator added.
* **Ingestion run:** A row in `ingestion_runs` holding one attempt's status.
* **Sync session:** The runs launched by one Sync now, sharing a `sync_session_id`.
* **Source:** A row in `sources`, the unit retrieval cites: a crawled page, video, document, CSV row, or a page a CSV row links to.
* **Embedding space:** One embedding model + dimension; its vectors live in `chunk_embeddings`.
* **Active space:** The space named in `embedding_active_space`, read by retrieval and written by ingestion.
* **Cutover lock:** Set while a space is activated or rolled back; ingestion routes answer 409 until it clears.
