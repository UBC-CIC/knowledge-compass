# Web Crawler Pipeline

## What It Does

`crawler.py` is a BFS web crawler that:
1. Uses **Playwright** (headless Chromium) to render JS-heavy pages — required for Wix/SPA sites
2. Extracts article content via **trafilatura** (readability-style boilerplate removal)
3. Chunks content at **heading boundaries** (H1/H2/H3) with optional semantic splitting
4. Embeds each chunk via **Cohere embed-english-v3** through Amazon Bedrock
5. Writes to the unified **`sources` + `chunks`** tables in RDS PostgreSQL (pgvector)

Change detection: each chunk stores a `content_hash` (sha256[:16] of body text). On re-crawl, chunks whose hash hasn't changed are skipped — no redundant embedding API calls.

---

## CLI Usage

```bash
# Install
pip install "crawlee[playwright]" trafilatura lxml beautifulsoup4 psycopg2-binary boto3
playwright install chromium
curl -o AmazonRootCA1.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

# Crawl only — outputs crawl_output.json
python crawler.py https://www.sourceforinclusiveeducation.ca --max-pages 100

# Crawl + fixed-size chunking + write to DB
python crawler.py https://www.sourceforinclusiveeducation.ca --max-pages 100 --write-db

# Crawl + semantic chunking + write to DB
python crawler.py https://www.sourceforinclusiveeducation.ca --max-pages 100 --write-db --semantic
```

| Flag | Default | Description |
|---|---|---|
| `--max-pages` | 50 | Maximum pages to crawl (BFS order) |
| `--max-words` | 650 | Max words per chunk before splitting |
| `--write-db` | false | Embed and write to DB |
| `--semantic` | false | Use semantic chunking (embeds sentences to detect topic boundaries) |
| `--semantic-threshold` | 0.6 | Cosine similarity threshold for topic boundary detection |
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
  - INSERT INTO crawl_runs (source_id, status='queued') → returns job_id to frontend
  - Calls ECS RunTask API with env vars: JOB_ID, SEED_URL, MAX_PAGES
         │
         ▼
ECS Fargate Task (Docker container with Playwright + crawler.py)
  - Reads JOB_ID, SEED_URL from env
  - Runs crawler.py
  - On completion: UPDATE crawl_runs SET status='completed' WHERE id=JOB_ID
  - On failure:    UPDATE crawl_runs SET status='failed', error_message=... WHERE id=JOB_ID
         │
         ▼
Admin dashboard polls crawl_runs by job_id → shows live status
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
- `AmazonRootCA1.pem` for RDS SSL
- IAM role with: `bedrock:InvokeModel` (Cohere embed), `rds-db:connect` (IAM auth to RDS)
