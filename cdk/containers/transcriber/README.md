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
4. Embeds each chunk via **Cohere embed-english-v3** through Amazon Bedrock
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
| `--semantic-threshold` | 0.5 | Cosine similarity threshold (lower than crawler because speech is more rambling) |
| `--output` | vtt_output.json | Local JSON preview file |

---

## Chunking Strategy

**Default (fixed-size with overlap):** accumulate segments up to `max_words`, carry last `overlap` segments into the next chunk.

**Semantic (`--semantic`):** embed all segment texts in one batched Cohere call, find cosine similarity drops between adjacent segments (topic changes), group segments between boundaries into chunks. `max_words` enforced as hard cap.

`embed_text` (what gets embedded) = `"Video: {name}\n[HH:MM:SS - HH:MM:SS]\n\nbody text"` — the title + timestamp prefix ensures the embedding captures which video and where in it the content appears.

---

## DB Write Details

One video → one `sources` row (`source_type='video'`, `url=youtube_url`).
Each chunk → one `chunks` row with:
- `embedding vector(1024)`
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

## Production Automation Architecture

```
Admin uploads video + provides source URL (frontend)
         │
         ▼
S3 PutObject event → EventBridge rule
         │
         ▼
Lambda (ingestion trigger)
  - Starts Transcribe job pointing at uploaded video
  - INSERT INTO ingestion_jobs (source_url, status='transcribing') → job_id to frontend
         │
         ▼
Transcribe completes → EventBridge completion event
         │
         ▼
Lambda (embedding trigger)
  - Downloads Transcribe JSON from S3
  - Runs transcrbe.py logic (chunking + embedding + DB write)
  - UPDATE ingestion_jobs SET status='completed' WHERE id=job_id
```

The two Lambdas can be the same function with different event triggers, or separate functions — both are small enough to run within Lambda's timeout.

**IAM role requirements:**
- `transcribe:StartTranscriptionJob`, `transcribe:GetTranscriptionJob`
- `s3:GetObject` (Transcribe output bucket), `s3:PutObject` (video upload bucket)
- `bedrock:InvokeModel` (Cohere embed)
- `rds-db:connect` (IAM auth to RDS)
