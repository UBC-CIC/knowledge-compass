# Video Transcription Pipeline

> **Security note:** This script is configured entirely through environment
> variables (see [Configuration](#configuration-secret-free)) and stores no
> credentials in source. An earlier committed version contained a hard-coded
> RDS credential; that credential is in git history and **must be rotated in
> AWS**. Removing it from the current source does not remove it from history.

## What It Does

`transcrbe.py` is a transcript ingestor that:
1. Reads `results.audio_segments` from an **AWS Transcribe job output JSON** (produced from a video file)
2. Converts float-second timestamps to `HH:MM:SS.mmm` format
3. Chunks segments by word count or **semantic similarity** (topic boundary detection)
4. Embeds each chunk through Amazon Bedrock with the model of the **active embedding space** (read from the database)
5. Writes to the unified **`sources` + `chunks`** tables in RDS PostgreSQL with timestamp metadata for deep-linking into the video

---

## Input Format

The input is the **full JSON output** from an AWS Transcribe job — **not** a raw audio or VTT file. Amazon Transcribe handles the video-to-text conversion and produces a structured JSON with sentence-level segments.

Key field used: `results.audio_segments` — an array of sentence-level segments, each with:
```json
{
  "id": 0,
  "transcript": "The sentence text here.",
  "start_time": "4.8",
  "end_time": "20.54",
  "language_code": "en-US",
  "items": [0, 1, 2, ...]
}
```

`audio_segments` is already sentence-grouped by Transcribe — no sentence reconstruction from word-level `items` is needed.

---

## Configuration (secret-free)

Configuration is read from the environment via the shared helper
`../common/db_config.py` — no credentials or endpoints in source. Copy
`../.env.example` to `.env` and fill in real values, or export them directly.
See the crawler README's configuration table for the full variable list; the
transcriber uses the same variables.

## CLI Usage

```bash
# Install
pip install -r requirements.txt

# (verify-full TLS) download the RDS CA bundle once and point env at it
curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
export DB_SSL_ROOT_CERT=$(pwd)/global-bundle.pem

# Configure DB access (IAM auth = no stored secret)
export DB_HOST=your-endpoint.rds.amazonaws.com DB_NAME=KC DB_USER=app_rw AWS_REGION=ca-central-1

# Preview only — outputs vtt_output.json, no DB write (no credentials needed)
python transcrbe.py asrOutput.json "https://youtube.com/watch?v=..." --name "Video Title"

# Fixed-size chunking + write to DB
python transcrbe.py asrOutput.json "https://youtube.com/watch?v=..." --name "Video Title" --write-db

# Semantic chunking + write to DB
python transcrbe.py asrOutput.json "https://youtube.com/watch?v=..." --name "Video Title" --write-db --semantic
```

| Flag | Default | Description |
|---|---|---|
| `--name` | filename | Human-readable video title (stored in `sources.name`) |
| `--max-words` | 400 | Max words per chunk |
| `--overlap` | 2 | Segments carried into next chunk for context overlap (fixed-size mode only) |
| `--write-db` | false | Embed and write to DB |
| `--semantic` | false | Embed segments first to detect topic boundaries |
| `--semantic-threshold` | active space's `split_threshold`, else 0.5 | Cosine similarity threshold (the 0.5 fallback is lower than the crawler's because speech is more rambling). Passing it explicitly always wins |
| `--output` | vtt_output.json | Local JSON preview file |

---

## Chunking Strategy

**Default (fixed-size with overlap):** accumulate segments up to `max_words`, carry last `overlap` segments into the next chunk.

**Semantic (`--semantic`):** embed all segment texts in one batched embedding call, find cosine similarity drops between adjacent segments (topic changes), group segments between boundaries into chunks. `max_words` enforced as hard cap.

`embed_text` (what gets embedded) = `"Video: {name}\n[HH:MM:SS - HH:MM:SS]\n\nbody text"` — the title + timestamp prefix ensures the embedding captures which video and where in it the content appears.

---

## DB Write Details

One video → one `sources` row (`source_type='video'`, `url=video_url`).
Each chunk → one `chunks` row with:
- one `chunk_embeddings` row holding its vector in the active embedding space
- `metadata = {"chunk_start": "00:01:23.000", "chunk_end": "00:03:45.000"}` — used for deep-linking
- `content_hash` for change detection on re-ingest

---

## How to Generate the Transcribe JSON

```
Admin uploads video file (mp4, mov, webm, etc.) to S3
    → AWS Console or CLI: start a Transcribe job pointing at the S3 file
    → Transcribe outputs JSON to a specified S3 output bucket
    → Download the JSON and pass it to transcrbe.py
```

AWS CLI example:
```bash
# Start job
aws transcribe start-transcription-job \
  --transcription-job-name my-job \
  --media MediaFileUri=s3://my-bucket/video.mp4 \
  --language-code en-US \
  --output-bucket-name my-output-bucket \
  --region ca-central-1

# Wait for completion, then download output
aws s3 cp s3://my-output-bucket/my-job.json ./asrOutput.json
```

---

## Production Flow

```
Admin uploads a video or audio file (presigned URL) and stages it with a public video_url
         │
         ▼
lambdaKnowledgeBase (helpers/video_transcription.py)
  - Starts an Amazon Transcribe job on the upload; output goes to transcripts/ in the ingest bucket
  - Records transcribe_job_name on the data source; the ingestion run stays pending
         │
         ▼
Transcribe completes → EventBridge rule → transcribeRelay Lambda → lambdaKnowledgeBase
  - FAILED: the run is marked failed
  - COMPLETED: launches the transcriber ECS task with JOB_ID, TRANSCRIPT_JSON,
    VIDEO_URL and VIDEO_NAME (deferred to the next Sync now during an embedding cutover)
         │
         ▼
transcrbe.py (this container)
  - Reads the Transcribe JSON from S3, chunks, embeds, writes sources/chunks/chunk_embeddings
  - Marks the ingestion run completed or failed
```

**Permissions** (`cdk/lib/ingestion-stack.ts`):
- Transcriber task role: `bedrock:InvokeModel` on the embedding models the spaces can use, read access to the ingest bucket and to the database secret. In ECS, `DB_AUTH=secret` is set on every `RunTask`; there is no `rds-db:connect`
- Transcribe data access role: read/write on the ingest bucket
- `lambdaKnowledgeBase`: starts Transcribe jobs and passes the data access role
