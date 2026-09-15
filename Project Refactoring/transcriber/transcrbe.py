#!/usr/bin/env python3
"""
AWS Transcribe JSON ingestor for the Inclusion Canada RAG pipeline.
Reads audio_segments from a Transcribe job output, chunks into overlapping
segments, embeds with Cohere, and writes to the unified sources + chunks tables
in RDS (source_type='video'), tracking the run in ingestion_runs.

Usage (parse + preview, no DB):
    python transcrbe.py asrOutput.json "https://youtube.com/watch?v=..." --name "Video Title"

Usage (parse + embed + write to DB):
    python transcrbe.py asrOutput.json "https://youtube.com/watch?v=..." --name "Video Title" --write-db

Usage (semantic chunking):
    python transcrbe.py asrOutput.json "https://youtube.com/watch?v=..." --name "Video Title" --write-db --semantic
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys

import boto3


# ── Shared secret-free config ─────────────────────────────────────────────────
# Prefer the package import; fall back to loading the sibling common/db_config.py
# by path so this script also works when copied standalone (e.g. onto SageMaker).
try:
    from common import db_config  # type: ignore
except ImportError:
    _common_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "common",
        "db_config.py",
    )
    if not os.path.exists(_common_path):
        _common_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "db_config.py")
    _spec = importlib.util.spec_from_file_location("db_config", _common_path)
    db_config = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(db_config)  # type: ignore


# ── Config (environment-driven) ───────────────────────────────────────────────

REGION = db_config.get_region()
EMBED_MODEL_ID = db_config.get_embed_model_id()
EMBED_BATCH_SIZE = db_config.get_embed_batch_size()

MAX_WORDS_PER_CHUNK    = 400   # ~1600 chars, well within Cohere 2048 char limit
OVERLAP_SEGMENTS       = 2     # segments carried into next chunk (fixed-size mode)
SEMANTIC_THRESHOLD_VTT = 0.5   # lower threshold for conversational speech


# ── Transcribe JSON Parser ────────────────────────────────────────────────────

def _seconds_to_ts(seconds: float) -> str:
    """Convert float seconds to HH:MM:SS.mmm timestamp string."""
    h  = int(seconds // 3600)
    m  = int((seconds % 3600) // 60)
    s  = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def resolve_transcript_path(transcript_json: str) -> str:
    """Download an s3:// Transcribe JSON to /tmp so the parser can read it."""
    if not transcript_json.startswith("s3://"):
        return transcript_json

    without = transcript_json[len("s3://"):]
    bucket, _, key = without.partition("/")
    if not bucket or not key:
        raise ValueError(f"Invalid S3 URI: {transcript_json}")

    local_path = "/tmp/transcript.json"
    print(f"Downloading {transcript_json} -> {local_path}", file=sys.stderr)
    boto3.client("s3", region_name=REGION).download_file(bucket, key, local_path)
    return local_path


def parse_transcribe_json(filepath: str) -> list:
    """
    Parse a Transcribe job output JSON file into a list of segments.
    Uses results.audio_segments — Transcribe already groups words into
    sentence-level segments with start/end timestamps.
    Each segment: {start, end, text}
    """
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    audio_segments = data.get("results", {}).get("audio_segments", [])
    if not audio_segments:
        raise ValueError(
            "No audio_segments found in JSON. "
            "Make sure this is a Transcribe job output (not just the raw transcript)."
        )

    segments = []
    for seg in audio_segments:
        text = seg.get("transcript", "").strip()
        if not text:
            continue
        start = _seconds_to_ts(float(seg["start_time"]))
        end   = _seconds_to_ts(float(seg["end_time"]))
        segments.append({"start": start, "end": end, "text": text})

    print(f"  {len(segments)} segments parsed from audio_segments", file=sys.stderr)
    return segments


# ── Semantic Chunking Utilities ──────────────────────────────────────────────

def _cosine_sim(a: list, b: list) -> float:
    """Dot product of two unit-normalized Cohere vectors = cosine similarity."""
    return sum(x * y for x, y in zip(a, b))


def _find_semantic_splits(embeddings: list, threshold: float) -> list:
    """Return indices where similarity drops below threshold (topic change)."""
    splits = [0]
    for i in range(len(embeddings) - 1):
        if _cosine_sim(embeddings[i], embeddings[i + 1]) < threshold:
            splits.append(i + 1)
    return splits


def _sub_split_segs(segs: list, video_name: str, video_url: str,
                    max_words: int, start_idx: int) -> list:
    """Word-count sub-split for semantic groups that exceed max_words."""
    chunks = []
    idx = start_idx
    buf_segs, buf_words = [], 0

    def _emit(buf):
        body = re.sub(r"\s+", " ", " ".join(s["text"] for s in buf)).strip()
        embed_text = f"Video: {video_name}\n[{buf[0]['start']} - {buf[-1]['end']}]\n\n{body}"
        return {
            "video_url":    video_url,
            "chunk_index":  None,
            "chunk_start":  buf[0]["start"],
            "chunk_end":    buf[-1]["end"],
            "body":         body,
            "embed_text":   embed_text,
            "word_count":   len(body.split()),
            "content_hash": hashlib.sha256(body.strip().encode()).hexdigest()[:16],
        }

    for seg in segs:
        sw = len(seg["text"].split())
        if buf_words + sw > max_words and buf_segs:
            c = _emit(buf_segs)
            c["chunk_index"] = idx
            chunks.append(c)
            idx += 1
            buf_segs, buf_words = [seg], sw
        else:
            buf_segs.append(seg)
            buf_words += sw

    if buf_segs:
        c = _emit(buf_segs)
        c["chunk_index"] = idx
        chunks.append(c)

    return chunks


def _chunk_segments_semantic(segments: list, video_name: str, video_url: str,
                              max_words: int, threshold: float) -> list:
    """
    Semantic chunking: embed all segments in one batch, find topic boundaries
    where cosine similarity drops, group segments between boundaries into chunks.
    max_words is a hard cap — oversized groups are sub-split by word count.
    """
    texts = [s["text"] for s in segments]
    print(f"  [semantic] embedding {len(texts)} segments for topic detection", file=sys.stderr)
    embeddings = embed_texts(texts, input_type="search_document")

    splits = _find_semantic_splits(embeddings, threshold) if len(texts) > 1 else [0]
    splits_with_end = splits + [len(segments)]

    chunks = []
    idx = 0

    for start, end in zip(splits_with_end, splits_with_end[1:]):
        group_segs  = segments[start:end]
        group_words = sum(len(s["text"].split()) for s in group_segs)

        if group_words <= max_words:
            body = re.sub(r"\s+", " ", " ".join(s["text"] for s in group_segs)).strip()
            if len(body.split()) < 20:
                continue
            chunk_start = group_segs[0]["start"]
            chunk_end   = group_segs[-1]["end"]
            embed_text  = f"Video: {video_name}\n[{chunk_start} - {chunk_end}]\n\n{body}"
            chunks.append({
                "video_url":    video_url,
                "chunk_index":  idx,
                "chunk_start":  chunk_start,
                "chunk_end":    chunk_end,
                "body":         body,
                "embed_text":   embed_text,
                "word_count":   len(body.split()),
                "content_hash": hashlib.sha256(body.strip().encode()).hexdigest()[:16],
            })
            idx += 1
        else:
            sub = _sub_split_segs(group_segs, video_name, video_url, max_words, idx)
            chunks.extend(sub)
            idx += len(sub)

    return chunks


# ── Chunker ───────────────────────────────────────────────────────────────────

def chunk_segments(segments: list, video_name: str, video_url: str,
                   max_words: int = MAX_WORDS_PER_CHUNK,
                   overlap: int = OVERLAP_SEGMENTS,
                   use_semantic: bool = False,
                   semantic_threshold: float = SEMANTIC_THRESHOLD_VTT) -> list:
    """
    Chunk transcript segments for embedding.
    Fixed-size mode: accumulate segments up to max_words with overlap.
    Semantic mode:   embed segments first, split at topic boundaries.
    """
    if not segments:
        return []

    if use_semantic:
        return _chunk_segments_semantic(segments, video_name, video_url,
                                        max_words, semantic_threshold)

    # ── Fixed-size with overlap ───────────────────────────────────────────────
    chunks = []
    idx = 0
    i = 0

    while i < len(segments):
        chunk_segs = []
        word_count = 0
        start_i = i

        while i < len(segments):
            seg = segments[i]
            seg_words = len(seg["text"].split())
            if word_count + seg_words > max_words and chunk_segs:
                break
            chunk_segs.append(seg)
            word_count += seg_words
            i += 1

        if not chunk_segs:
            break

        body = re.sub(r"\s+", " ", " ".join(s["text"] for s in chunk_segs)).strip()
        chunk_start = chunk_segs[0]["start"]
        chunk_end   = chunk_segs[-1]["end"]
        embed_text  = f"Video: {video_name}\n[{chunk_start} - {chunk_end}]\n\n{body}"

        chunks.append({
            "video_url":    video_url,
            "chunk_index":  idx,
            "chunk_start":  chunk_start,
            "chunk_end":    chunk_end,
            "body":         body,
            "embed_text":   embed_text,
            "word_count":   len(body.split()),
            "content_hash": hashlib.sha256(body.strip().encode()).hexdigest()[:16],
        })
        idx += 1
        i = max(start_i + 1, i - overlap)

    return chunks


# ── Embeddings ────────────────────────────────────────────────────────────────

def embed_texts(texts: list, input_type: str = "search_document") -> list:
    """Embed texts using Cohere embed-english-v3 via Amazon Bedrock."""
    client = boto3.client("bedrock-runtime", region_name=REGION)
    embeddings = []
    safe_texts = [t[:2048].rsplit(" ", 1)[0] if len(t) > 2048 else t for t in texts]

    for i in range(0, len(safe_texts), EMBED_BATCH_SIZE):
        batch = safe_texts[i : i + EMBED_BATCH_SIZE]
        response = client.invoke_model(
            modelId=EMBED_MODEL_ID,
            body=json.dumps({
                "texts": batch,
                "input_type": input_type,
                "truncate": "END",
            }),
            contentType="application/json",
            accept="application/json",
        )
        result = json.loads(response["body"].read())
        embeddings.extend(result["embeddings"])
        print(f"  [embed] batch {i // EMBED_BATCH_SIZE + 1} — {len(batch)} texts",
              file=sys.stderr)

    return embeddings


# ── Database ──────────────────────────────────────────────────────────────────

def get_db_connection():
    """
    Open a connection using the shared secret-free config. Credentials come from
    the environment (RDS IAM auth by default). No secrets are stored in source.
    """
    return db_config.get_db_connection()


def upsert_source(conn, video_url: str, name: str) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO sources (name, url, source_type)
            VALUES (%s, %s, 'video')
            ON CONFLICT (url) DO UPDATE SET
              name = EXCLUDED.name, updated_at = now()
            RETURNING id
            """,
            (name, video_url),
        )
        return str(cur.fetchone()[0])


def get_existing_chunk_hashes(conn, source_id: str) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chunk_index, content_hash FROM chunks WHERE source_id = %s",
            (source_id,),
        )
        return {row[0]: row[1] for row in cur.fetchall()}


def upsert_chunk(conn, source_id: str, chunk: dict, embedding: list) -> None:
    embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"
    metadata = json.dumps({
        "chunk_start": chunk["chunk_start"],
        "chunk_end":   chunk["chunk_end"],
    })
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO chunks (
              source_id, chunk_index, body, embed_text,
              word_count, content_hash, embedding, metadata, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s::vector, %s::jsonb, now())
            ON CONFLICT (source_id, chunk_index) DO UPDATE SET
              body         = EXCLUDED.body,
              embed_text   = EXCLUDED.embed_text,
              word_count   = EXCLUDED.word_count,
              content_hash = EXCLUDED.content_hash,
              embedding    = EXCLUDED.embedding,
              metadata     = EXCLUDED.metadata,
              updated_at   = now()
            """,
            (source_id, chunk["chunk_index"], chunk["body"], chunk["embed_text"],
             chunk["word_count"], chunk["content_hash"], embedding_str, metadata),
        )


def delete_stale_chunks(conn, source_id: str, current_indices: list) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM chunks WHERE source_id = %s AND chunk_index != ALL(%s)",
            (source_id, current_indices),
        )
        return cur.rowcount


# ── Ingestion run tracking (unified ingestion_runs) ───────────────────────────

def start_ingestion_run(conn, source_id: str, job_id: str = None) -> str:
    """
    Begin (or adopt) an ingestion run in the unified `ingestion_runs` table.
    If `job_id` is provided (row pre-created by the ingestion-trigger Lambda),
    mark it 'running'; otherwise insert a fresh row. Returns the run id.
    """
    with conn.cursor() as cur:
        if job_id:
            cur.execute(
                """
                UPDATE ingestion_runs
                   SET status = 'running', source_id = %s, started_at = now()
                 WHERE id = %s
                RETURNING id
                """,
                (source_id, job_id),
            )
            row = cur.fetchone()
            if row:
                return str(row[0])
        cur.execute(
            """
            INSERT INTO ingestion_runs (source_id, status, started_at)
            VALUES (%s, 'running', now())
            RETURNING id
            """,
            (source_id,),
        )
        return str(cur.fetchone()[0])


def finish_ingestion_run(conn, run_id: str, status: str, stats: dict, error_message: str = None) -> None:
    """Finalize an ingestion run in the unified `ingestion_runs` table."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ingestion_runs SET
              status          = %s,
              chunks_upserted = %s,
              chunks_deleted  = %s,
              error_message   = %s,
              finished_at     = now(),
              completed_at    = now()
            WHERE id = %s
            """,
            (
                status,
                stats.get("chunks_upserted", 0),
                stats.get("chunks_deleted", 0),
                error_message,
                run_id,
            ),
        )


# ── DB Writer ─────────────────────────────────────────────────────────────────

def write_to_db(chunks: list, video_url: str, name: str, job_id: str = None) -> None:
    conn = get_db_connection()
    stats = {"chunks_upserted": 0, "chunks_deleted": 0}
    run_id = None
    try:
        source_id = upsert_source(conn, video_url, name)
        conn.commit()

        run_id = start_ingestion_run(conn, source_id, job_id=job_id)
        conn.commit()

        existing  = get_existing_chunk_hashes(conn, source_id)
        to_embed  = [c for c in chunks if existing.get(c["chunk_index"]) != c["content_hash"]]
        unchanged = len(chunks) - len(to_embed)

        if to_embed:
            embeddings = embed_texts([c["embed_text"] for c in to_embed])
            for chunk, embedding in zip(to_embed, embeddings):
                upsert_chunk(conn, source_id, chunk, embedding)
            stats["chunks_upserted"] = len(to_embed)

        deleted = delete_stale_chunks(conn, source_id, [c["chunk_index"] for c in chunks])
        stats["chunks_deleted"] = deleted

        finish_ingestion_run(conn, run_id, "completed", stats)
        conn.commit()
        print(f"\n[db] Done — {len(to_embed)} embedded, {unchanged} unchanged, {deleted} deleted",
              file=sys.stderr)
    except Exception as e:
        conn.rollback()
        if run_id:
            try:
                finish_ingestion_run(conn, run_id, "failed", stats, error_message=str(e)[:1000])
                conn.commit()
            except Exception:
                pass
        raise e
    finally:
        conn.close()


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    # When run as an ECS/Lambda task, the ingestion-trigger passes work via env
    # vars. CLI args take precedence; env vars provide defaults. JOB_ID adopts a
    # pre-created ingestion_runs row.
    env_transcript = os.environ.get("TRANSCRIPT_JSON")
    env_video_url = os.environ.get("VIDEO_URL")
    env_name = os.environ.get("VIDEO_NAME", "")
    env_job_id = os.environ.get("JOB_ID")
    env_write_db = os.environ.get("WRITE_DB", "").strip().lower() in ("1", "true", "yes")
    env_semantic = os.environ.get("SEMANTIC", "").strip().lower() in ("1", "true", "yes")

    parser = argparse.ArgumentParser(
        description="Parse AWS Transcribe JSON → chunk → embed → write to pgvector DB"
    )
    parser.add_argument("transcript_json", nargs="?", default=env_transcript,
                        help="Path to Transcribe job output JSON (or TRANSCRIPT_JSON env)")
    parser.add_argument("video_url", nargs="?", default=env_video_url,
                        help="YouTube URL this transcript belongs to (or VIDEO_URL env)")
    parser.add_argument("--name",          default=env_name, help="Human-readable video title (or VIDEO_NAME env)")
    parser.add_argument("--max-words",     type=int, default=MAX_WORDS_PER_CHUNK,
                        help="Max words per chunk (default 400)")
    parser.add_argument("--overlap",       type=int, default=OVERLAP_SEGMENTS,
                        help="Segments to carry into next chunk for overlap (fixed-size mode only)")
    parser.add_argument("--semantic",      action="store_true", default=env_semantic,
                        help="Use semantic chunking — embed segments to detect topic boundaries")
    parser.add_argument("--semantic-threshold", type=float, default=SEMANTIC_THRESHOLD_VTT,
                        help="Cosine similarity threshold for topic splits (default 0.5)")
    parser.add_argument("--output",        default="vtt_output.json")
    parser.add_argument("--write-db",      action="store_true", default=env_write_db,
                        help="Embed chunks and write to database (or WRITE_DB env)")
    parser.add_argument("--job-id",        default=env_job_id,
                        help="Adopt an existing ingestion_runs row id (or JOB_ID env)")
    args = parser.parse_args()

    if not args.transcript_json or not args.video_url:
        parser.error("transcript_json and video_url are required (pass as args or set TRANSCRIPT_JSON/VIDEO_URL env)")

    name = args.name or args.transcript_json

    print(f"Parsing {args.transcript_json}...", file=sys.stderr)
    transcript_path = resolve_transcript_path(args.transcript_json)
    segments = parse_transcribe_json(transcript_path)

    if args.semantic:
        print(f"Semantic chunking enabled (threshold={args.semantic_threshold})",
              file=sys.stderr)

    chunks = chunk_segments(
        segments,
        video_name=name,
        video_url=args.video_url,
        max_words=args.max_words,
        overlap=args.overlap,
        use_semantic=args.semantic,
        semantic_threshold=args.semantic_threshold,
    )

    word_counts = [c["word_count"] for c in chunks]
    result = {
        "video_url":        args.video_url,
        "name":             name,
        "transcript_json":  args.transcript_json,
        "total_segments":   len(segments),
        "total_chunks":     len(chunks),
        "chunking_mode":    "semantic" if args.semantic else "fixed-size",
        "chunk_stats": {
            "avg_words": round(sum(word_counts) / len(word_counts), 1) if word_counts else 0,
            "min_words": min(word_counts) if word_counts else 0,
            "max_words": max(word_counts) if word_counts else 0,
        },
        "chunks": chunks,
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(
        f"\nDone: {len(segments)} segments → {len(chunks)} chunks "
        f"({result['chunking_mode']}) → {args.output}",
        file=sys.stderr,
    )
    if word_counts:
        s = result["chunk_stats"]
        print(
            f"Chunk stats: avg={s['avg_words']} words, "
            f"min={s['min_words']}, max={s['max_words']}",
            file=sys.stderr,
        )

    if args.write_db:
        print("\nWriting embeddings to database...", file=sys.stderr)
        write_to_db(chunks, args.video_url, name, job_id=args.job_id)


if __name__ == "__main__":
    main()
