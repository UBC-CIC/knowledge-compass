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
4. Embeds each chunk via **Cohere embed-english-v3** through Amazon Bedrock
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

**Semantic (`--semantic`):** embeds each sentence individually, finds cosine similarity drops between adjacent sentences (topic changes), splits there. `max_words` is applied as a hard cap. Costs one extra Cohere batch call per page.

`embed_text` (what gets embedded) = `"Section > Subsection\n\nBody text"` — heading path prefix ensures the embedding captures WHERE in the site the content lives, not just WHAT it says.

---

## DB Write Details

Each page → one `sources` row (`source_type='web'`, `url=page_url`).
Each chunk → one `chunks` row with:
- `embedding vector(1024)`
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
  - Calls ECS RunTask API with env vars: JOB_ID, SEED_URL, MAX_PAGES, WRITE_DB
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

## Docker Container Requirements

The ECS Fargate container needs:
- Python 3.11+
- `crawlee[playwright]`, `trafilatura`, `lxml`, `beautifulsoup4`, `psycopg2-binary`, `boto3`
- Playwright chromium (`playwright install chromium`)
- The RDS CA bundle fetched at build/runtime (`global-bundle.pem`), with
  `DB_SSL_ROOT_CERT` pointing at it — not a committed cert
- Config via environment variables (`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_AUTH=iam`, ...)
- IAM task role with: `bedrock:InvokeModel` (Cohere embed), `rds-db:connect` (IAM auth to RDS)
