# Knowledge Compass — Project Refactoring Handoff

## What This Is

Knowledge Compass is a RAG-powered conversational assistant for Inclusion Canada, helping families navigate inclusive education in Canada. This directory contains the prototype work built during the refactoring sprint: data ingestion pipelines, the RAG conversation notebook, and the user stories that drive the prompt design.

The existing production system (`cdk/lambda/textGeneration/`) uses **Bedrock Knowledge Bases** for retrieval. This sprint replaces that with a **pgvector-based retrieval pipeline** backed by a unified `sources` + `chunks` schema, so retrieval works across both web content and video transcripts from a single query.

---

## Directory Structure

```
Project Refactoring/
  crawler/           Web crawler pipeline (Playwright → chunking → pgvector)
  transcriber/       Video transcript pipeline (Transcribe JSON → chunking → pgvector)
  user-stories/      Inclusion Canada user stories that drive the prompt design
  textgen_v1.ipynb   RAG conversation prototype notebook
```

---

## Testing Environment

A live testing environment exists on **Amazon SageMaker** in the JupyterLab instance named **`web-crawler-demo-2`** (ca-central-1). This instance is in the same VPC as the RDS database and has the necessary IAM permissions for Bedrock and RDS IAM auth.

> **This is for testing only — not production.** Scripts are run manually from the JupyterLab terminal here to validate the pipeline end to end.

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
4. Copy the script you want to test (`crawler.py`, `transcrbe.py`, `textgen_v1.ipynb`) into the SageMaker home directory (`/home/ec2-user/SageMaker/`)
5. Install dependencies for that script and run it

**You do not need to replicate this repo's directory structure on SageMaker.** Just copy the individual script files you need — the SageMaker instance is a scratch environment for running and validating scripts, not a mirror of the repo.

---

## Three Data Pipelines

### 1. Web Crawler
Crawls Inclusion Canada's website, extracts article content, chunks it semantically, and embeds it into pgvector.

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
Admin uploads a video file → Amazon Transcribe converts it to a structured JSON → the ingestor chunks it by speaker segment and embeds into pgvector with timestamps for deep-linking.

See [`transcriber/README.md`](transcriber/README.md) for full technical detail.

```
Admin uploads video to S3 + provides source URL
    → S3 PutObject event → EventBridge rule
    → Lambda: starts Transcribe job, inserts ingestion job row in DB
    → Transcribe completion event → EventBridge
    → Lambda: runs transcrbe.py logic, updates job row status
```

### 3. RAG Conversation (textgen_v1.ipynb)
A Jupyter notebook that demonstrates the full conversation flow: detective phase (gather context) → pgvector retrieval → suggestion phase (provide guidance + cited sources). This is the prototype that the production textGen Lambda should be refactored to match.

---

## Database Schema

Migrations live in `cdk/lambda/db_setup/migrations/`. The three relevant migrations:

| Migration | Tables Added | Purpose |
|---|---|---|
| `001_crawler_embeddings.js` | `crawl_sources`, `crawl_runs`, `crawl_pages`, `page_chunks` | Original web crawl schema (superseded by 003) |
| `002_video_chunks.js` | `video_sources`, `video_chunks` | Original video schema (superseded by 003) |
| `003_unified_chunks.js` | `sources`, `chunks`, `crawl_runs` | Unified schema — everything goes here |

**`sources` table:** one row per ingested source (web page or video).
- `source_type`: `'web'` or `'video'`
- `url`: canonical URL (web page URL or YouTube link)

**`chunks` table:** one row per embedded text chunk.
- `embedding vector(1024)`: Cohere embed-english-v3 via Amazon Bedrock
- `metadata jsonb`: type-specific fields — web: `{"heading_path": "..."}`, video: `{"chunk_start": "HH:MM:SS", "chunk_end": "HH:MM:SS"}`
- `content_hash`: sha256 first 16 hex chars of body — used for change detection on re-ingest

---

## textGen Lambda Refactoring Plan

The production Lambda is at `cdk/lambda/textGeneration/`. Here is what needs to change and what stays the same.

### What stays unchanged

| File | What it does |
|---|---|
| `chat.py` | Full orchestration: guardrails → prepare → generate → save |
| `crud.py` | Session management, message history, DB writes |
| `guardrail.py` | Bedrock Guardrails (PII, content moderation) |
| `intervention.py` | Hallucination/grounding assessment |
| `message_limits.py` | Daily quota enforcement |
| `session_security.py` | Session ownership validation |
| `cors.py` | CORS headers |

The `<answer>/<cited_indices>` response format is already implemented correctly in `chat.py` — no changes needed there.

### What changes

**1. `helpers/bedrock.py`**
Remove: `retrieve_documents()` (calls Bedrock Knowledge Base `retrieve` API).
Replace with: `retrieve_from_pgvector(query, db_conn, top_k, min_score)` — runs a cosine similarity query against the `chunks` + `sources` tables.

```python
# New function (see textgen_v1.ipynb → retrieve() for reference implementation)
def retrieve_from_pgvector(query, db_conn, top_k=10, min_score=0.40):
    # 1. Embed query with Cohere embed-english-v3, input_type="search_query"
    # 2. Run: SELECT c.body, c.metadata, s.url, s.name, s.source_type,
    #            1 - (c.embedding <=> %s::vector) AS score
    #         FROM chunks c JOIN sources s ON s.id = c.source_id
    #         WHERE c.embedding IS NOT NULL
    #         ORDER BY c.embedding <=> %s::vector LIMIT %s
    # 3. Filter by min_score, deduplicate by URL
    # 4. Return same shape as current retrieve_documents() output
```

**2. `helpers/logic.py`**
Remove: UBC specialization prompt, SPEC_PROMPT, checklist variables.
Replace with: Knowledge Compass prompts from `textgen_v1.ipynb` — `PROMPT_ROLE`, `PROMPT_GUARDRAILS`, `PROMPT_LANGUAGE_GUIDELINES`, `PROMPT_DETECTIVE`, `PROMPT_SUGGESTION`.

The assembly pattern (plain text variables wrapped in XML tags by `get_current_prompt()`) already matches — just swap the content.

Detective phase: uses Haiku (fast, cheap) — keep this.
Suggestion phase: uses Sonnet — keep this.

**3. `helpers/config.py`**
Remove: `SPEC_LIST`, `KB_SECRET_NAME`, `KB_ID` (no Bedrock KB needed).
Add: new prompt variable defaults matching `textgen_v1.ipynb`.
Keep: DB connection config, model ARNs, guardrail config, message limits.

**4. `_prepare_conversation()` in `chat.py`**
Change one line: replace `retrieve_documents(search_query, knowledge_base_id, ...)` with `retrieve_from_pgvector(search_query, db_connection, ...)`.

### New file to create

**`helpers/retrieval.py`**
Extract the pgvector query logic from `textgen_v1.ipynb` (`retrieve()` + `format_context()`) into a Lambda-safe module that reuses the existing `db_connection` pool from `db_connection.py`.

### What does NOT need to change

- Frontend (`frontend/`): already handles `<answer>` tag stripping and source rendering
- WebSocket streaming: `converse_stream` stays as-is
- API Gateway / CDK stacks: no changes needed
- Auth, rate limiting, session management: untouched

### Environment variables to remove
- `KB_SECRET_NAME` (Bedrock KB secret — no longer needed)

### Environment variables to keep
- `REGION`, `LLM_REGION`, `GUARDRAIL_ID`, `GUARDRAIL_VERSION`, `HAIKU_ARN`, `SONNET_ARN`
- DB connection variables (unchanged)

---

## Current State vs Target State

| | Current (production) | Target (after refactor) |
|---|---|---|
| Retrieval | Bedrock Knowledge Base API | pgvector cosine similarity query |
| Content sources | S3 documents + web crawler configured in AWS console | `sources` + `chunks` tables in RDS |
| Prompts | UBC specialization explorer | Inclusion Canada inclusive education guide |
| Language enforcement | None | Inclusion Canada language toolkit (in guardrails) |
| Journey coverage | Single journey (UBC specializations) | 2 journeys, 17 stages, 57 user stories |
| Prompt caching | Yes (cache breakpoint in chat.py) | Same — keep as-is |
| Video support | None | `chunks` table with timestamp metadata |

---

## See Also

- [`crawler/README.md`](crawler/README.md) — web crawler pipeline
- [`transcriber/README.md`](transcriber/README.md) — video transcription pipeline
- [`user-stories/README.md`](user-stories/README.md) — user stories and prompt design
- `cdk/lambda/textGeneration/helpers/` — production Lambda helpers to refactor
- `cdk/lambda/db_setup/migrations/003_unified_chunks.js` — unified DB schema
