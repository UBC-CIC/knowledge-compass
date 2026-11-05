# Web Crawler Pipeline

> **Security note:** This script is configured entirely through environment
> variables (see [Configuration](#configuration-secret-free)) and stores no
> credentials in source. An earlier committed version contained a hard-coded
> RDS credential; that credential is in git history and **must be rotated in
> AWS**. Removing it from the current source does not remove it from history.

## What It Does

`crawler.py` is a BFS web crawler that:
1. Uses **Playwright** (headless Chromium) to render JS-heavy pages — required for Wix/SPA sites
2. Extracts article content via **trafilatura** (readability-style boilerplate removal)
3. Chunks content at **heading boundaries** (H1/H2/H3) with optional semantic splitting
4. Embeds each chunk through Amazon Bedrock with the model of the **active embedding space** (read from the database)
5. Writes to the unified **`sources` + `chunks`** tables in RDS PostgreSQL (pgvector)

Change detection: each chunk stores a `content_hash` (sha256[:16] of body text). On re-crawl, chunks whose hash hasn't changed are skipped — no redundant embedding API calls.

---

## Configuration (secret-free)

This script has **no credentials or endpoints in source**. All configuration is
read from the environment via the shared helper `../common/db_config.py`.
Copy `../.env.example` to `.env` and fill in real values, or export them directly.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DB_HOST` | yes | — | RDS / RDS Proxy endpoint |
| `DB_NAME` | yes | — | Database name |
| `DB_USER` | yes | — | DB user (IAM-auth role for `iam` mode) |
| `AWS_REGION` | no | `us-east-1` | AWS region |
| `DB_AUTH` | no | `iam` | `iam` \| `secret` \| `password` |
| `DB_SECRET_NAME` | if `secret` | — | Secrets Manager secret id |
| `DB_PASSWORD` | if `password` | — | Local dev only |
| `DB_PORT` | no | `5432` | |
| `DB_SSLMODE` | no | `verify-full` | |
| `DB_SSL_ROOT_CERT` | no | system trust | Path to RDS CA bundle |
| `EMBED_MODEL_ID` | no | `cohere.embed-english-v3` | Deprecated fallback; the model comes from the active embedding space in the database. Used only when the database cannot be read and the run does not write to it |
| `EMBED_BATCH_SIZE` | no | `96` | Deprecated fallback, same rule as `EMBED_MODEL_ID` |

## CLI Usage

```bash
# Install
pip install -r requirements.txt
playwright install chromium

# (verify-full TLS) download the RDS CA bundle once and point env at it
curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
export DB_SSL_ROOT_CERT=$(pwd)/global-bundle.pem

# Configure DB access (IAM auth = no stored secret)
export DB_HOST=your-endpoint.rds.amazonaws.com DB_NAME=KC DB_USER=app_rw AWS_REGION=ca-central-1

# Crawl only — outputs crawl_output.json (no DB, no credentials needed)
python crawler.py https://www.sourceforinclusiveeducation.ca --max-pages 100

# Crawl + fixed-size chunking + write to DB
python crawler.py https://www.sourceforinclusiveeducation.ca --max-pages 100 --write-db

# Crawl + semantic chunking + write to DB
python crawler.py https://www.sourceforinclusiveeducation.ca --max-pages 100 --write-db --semantic
```

| Flag | Default | Description |
|---|---|---|
| `--max-pages` | 50 | Maximum pages to crawl (BFS order) |
| `--max-words` | 300 | Max words per chunk before splitting |
| `--write-db` | false | Embed and write to DB |
| `--semantic` | false | Use semantic chunking (embeds sentences to detect topic boundaries) |
| `--semantic-threshold` | active space's `split_threshold`, else 0.6 | Cosine similarity threshold for topic boundary detection. Passing it explicitly always wins |
| `--output` | crawl_output.json | Local JSON output file |

---

## Chunking Strategy

**Default (fixed-size):** splits at heading boundaries (H1/H2/H3 from trafilatura XML output). Sections longer than `max_words` are split at sentence boundaries with 2-sentence overlap.

**Semantic (`--semantic`):** embeds each sentence individually, finds cosine similarity drops between adjacent sentences (topic changes), splits there. `max_words` is applied as a hard cap. Costs one extra embedding batch call per page.

`embed_text` (what gets embedded) = `"Section > Subsection\n\nBody text"` — heading path prefix ensures the embedding captures WHERE in the site the content lives, not just WHAT it says.

---

## DB Write Details

Each page → one `sources` row (`source_type='web'`, `url=page_url`).
Each chunk → one `chunks` row with:
- one `chunk_embeddings` row holding its vector in the active embedding space
- `metadata = {"heading_path": "Section > Subsection"}`
- `content_hash` for change detection

---

## Why It Can't Run in Lambda

Playwright requires a full Chromium binary (~300MB + dependencies). AWS Lambda has a 250MB deployment package limit and a 512MB–10GB `/tmp` limit — Chromium exceeds both when combined with other dependencies.

**Production Architecture:**

```
Admin triggers crawl (frontend button)
         │
         ▼
Lambda (proxy function)
  - Validates request
  - INSERT INTO ingestion_runs (source_id, status='queued') → returns job_id to frontend
  - Calls ECS RunTask API with env vars: JOB_ID, SEED_URL, MAX_PAGES, WRITE_DB,
    CRAWL_INCLUDE_PATTERNS, CRAWL_EXCLUDE_PATTERNS
         │
         ▼
ECS Fargate Task (Docker container with Playwright + crawler.py)
  - Reads JOB_ID, SEED_URL from env
  - Runs crawler.py
  - On completion: UPDATE ingestion_runs SET status='completed' WHERE id=JOB_ID
  - On failure:    UPDATE ingestion_runs SET status='failed', error_message=... WHERE id=JOB_ID
         │
         ▼
Admin dashboard polls ingestion_runs by job_id → shows live status
```

**Automation (scheduled re-crawl):**
```
EventBridge cron rule (e.g. every Sunday 2am)
    → triggers the same Lambda proxy
    → Lambda starts ECS task for each configured source
```
The Lambda is the consistent entry point — whether triggered by a human (frontend) or a schedule (EventBridge), the ECS task logic is identical.

---

## URL Safety

The crawler runs inside the VPC with database and Bedrock access, so it only
fetches public http(s) destinations:

- The website seed is validated three times: at staging
  (`stage_data_sources.py`, stored normalized), again before `ecs:RunTask`
  (`process_crawler_batch.py`; a rejected seed fails the run), and in the
  container before crawling (`validate_seed_url`). Rules: http/https only, no
  embedded credentials, ports 80/443/8080/8443, and every resolved address
  must be public (no private, loopback, link-local/metadata, or reserved).
- Every browser request is routed through `guard_route` (Playwright
  `BrowserContext.route`, so popups opened by a crawled page are covered
  too), which aborts non-public hosts and non-http(s) schemes;
  navigations are refused in a pre-navigation hook; enqueued links are
  filtered; service workers are blocked so they cannot bypass routing.
- `common/url_safety.py` mirrors the Lambda `helpers/url_safety.py`; keep the
  two in sync.

Limits: Chromium resolves DNS again after the check (DNS rebinding), redirect
hops of a navigation are not routed (the final URL is re-checked and nothing
is stored from a non-public one), WebSockets are not guarded, and the
Chromium sandbox is disabled on Fargate (see the Dockerfile).

---

## Include / Exclude Patterns

A website's `include_patterns` and `exclude_patterns` limit what is crawled.
Each is a list of Python regular expressions matched with `re.search` against
the page URL (one per line in the admin form). A URL is in scope when no
exclude pattern matches and, if include patterns exist, at least one include
pattern matches. `common/crawl_scope.py` holds the rules; the Lambda copy
`helpers/crawl_scope.py` must stay identical (a test compares them).

- Staging rejects a malformed pattern, more than 20 patterns per list, a
  pattern over 300 characters, and a seed URL the patterns would exclude, with
  a 400. `process_crawler_batch.py` re-checks stored rows before `ecs:RunTask`
  and fails the run instead of launching.
- The Lambda passes the patterns as `CRAWL_INCLUDE_PATTERNS` and
  `CRAWL_EXCLUDE_PATTERNS` (JSON arrays). Re-crawls go through the same launch.
- In the container, the patterns apply to the seed (checked before anything is
  fetched), to discovered links (not enqueued), to every navigation (refused in
  the pre-navigation hook; page and frame navigations are also aborted in
  `guard_route`), and to the URL a page ended on after redirects (nothing is
  stored and no links are followed from it).
- URLs are compared as given and in a canonical spelling (lowercase host,
  default port dropped, unreserved percent-escapes decoded, `.`/`..` and
  repeated slashes removed), so `/a/%70rivate/` cannot slip past an exclude
  written for `/a/private/`. The path is case-sensitive; use `(?i)` to ignore case.

Limit: a redirect hop is not routed, so an in-scope URL that redirects to an
excluded one is loaded by the browser; its content is discarded.

Nothing removes pages that were ingested before their patterns were enforced:
a re-crawl only adds and refreshes pages, it never deletes one it skipped.
Patterns cannot be edited on an existing website, so to apply or change them,
delete the website (the pages it alone owns are deleted with their chunks and
vectors, see `helpers/web_sources.py`) and add it again with the patterns. A
page another website also crawled is kept while that website still owns it.

---

## Docker Container Requirements

The ECS Fargate container needs:
- Python 3.11+
- `crawlee[playwright]`, `trafilatura`, `lxml`, `beautifulsoup4`, `psycopg2-binary`, `boto3`
- Playwright chromium (`playwright install chromium`)
- The RDS CA bundle fetched at build/runtime (`global-bundle.pem`), with
  `DB_SSL_ROOT_CERT` pointing at it — not a committed cert
- Config via environment variables (`DB_HOST`, `DB_NAME`, `DB_USER`, ...). In ECS, `process_crawler_batch.py` sets `DB_AUTH=secret` and `DB_SECRET_NAME` on every `RunTask`, because RDS Proxy does not accept IAM tokens
- IAM task role (`cdk/lib/ingestion-stack.ts`) with: `bedrock:InvokeModel` on the embedding models the spaces can use, and read access to the database secret. No `rds-db:connect`
