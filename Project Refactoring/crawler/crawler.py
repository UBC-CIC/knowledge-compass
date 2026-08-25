#!/usr/bin/env python3
"""
Prototype web crawler + chunker + embeddings writer for the Inclusion Canada RAG pipeline.

Usage (crawl only):
    python scripts/crawl_test.py https://www.sourceforinclusiveeducation.ca --max-pages 50

Usage (crawl + embed + write to DB):
    python scripts/crawl_test.py https://www.sourceforinclusiveeducation.ca --max-pages 50 --write-db

Requirements:
    pip install "crawlee[playwright]" trafilatura lxml beautifulsoup4 psycopg2-binary boto3
    playwright install chromium
"""

import argparse
import asyncio
import hashlib
import json
import re
import sys
from xml.etree import ElementTree as ET

import boto3
import psycopg2
import trafilatura
from bs4 import BeautifulSoup
from crawlee.crawlers import PlaywrightCrawler, PlaywrightCrawlingContext


# ── Config ────────────────────────────────────────────────────────────────────

REGION = "ca-central-1"

DB_HOST = "kc-database-kcdatabasedatabase02579448-iw9mhy8sqo4a.crecym6ketcm.ca-central-1.rds.amazonaws.com"
DB_NAME = "KC"
DB_USER = "app_rw"
DB_PORT = 5432
SSL_CERT = "../AmazonRootCA1.pem"

EMBED_MODEL_ID = "cohere.embed-english-v3"
EMBED_BATCH_SIZE = 96  # Cohere API limit per call


# ── Database ──────────────────────────────────────────────────────────────────

def get_db_connection():
    """IAM auth connection to RDS — token is valid for 15 minutes."""
    token = "abf4ccf3c559d547d051f2056ef86e5f"
    return psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        database=DB_NAME,
        user=DB_USER,
        password=token,
        sslmode="verify-full",
        sslrootcert=SSL_CERT,
    )


def upsert_source(conn, url: str, name: str, source_type: str = "web") -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO sources (name, url, source_type)
            VALUES (%s, %s, %s)
            ON CONFLICT (url) DO UPDATE SET
              name        = EXCLUDED.name,
              source_type = EXCLUDED.source_type,
              updated_at  = now()
            RETURNING id
            """,
            (name, url, source_type),
        )
        return str(cur.fetchone()[0])


def start_crawl_run(conn, source_id: str) -> str:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO crawl_runs (source_id, status, started_at) VALUES (%s, 'running', now()) RETURNING id",
            (source_id,),
        )
        return str(cur.fetchone()[0])


def finish_crawl_run(conn, run_id: str, status: str, stats: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE crawl_runs SET
              status          = %s,
              pages_crawled   = %s,
              pages_skipped   = %s,
              chunks_upserted = %s,
              chunks_deleted  = %s,
              finished_at     = now()
            WHERE id = %s
            """,
            (
                status,
                stats.get("pages_crawled", 0),
                stats.get("pages_skipped", 0),
                stats.get("chunks_upserted", 0),
                stats.get("chunks_deleted", 0),
                run_id,
            ),
        )


def get_existing_chunk_hashes(conn, source_id: str) -> dict:
    """Returns {chunk_index: content_hash} for all stored chunks for this source."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chunk_index, content_hash FROM chunks WHERE source_id = %s",
            (source_id,),
        )
        return {row[0]: row[1] for row in cur.fetchall()}


def upsert_chunk(conn, source_id: str, chunk: dict, embedding: list) -> None:
    embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"
    metadata = json.dumps({"heading_path": chunk.get("heading_path")})
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
            (
                source_id,
                chunk["chunk_index"],
                chunk["body"],
                chunk["text"],
                chunk["word_count"],
                chunk["content_hash"],
                embedding_str,
                metadata,
            ),
        )


def delete_stale_chunks(conn, source_id: str, current_indices: list) -> int:
    """Remove chunks that no longer exist (source re-crawled with fewer chunks)."""
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM chunks WHERE source_id = %s AND chunk_index != ALL(%s)",
            (source_id, current_indices),
        )
        return cur.rowcount


# ── Embeddings ────────────────────────────────────────────────────────────────

def embed_texts(texts: list, input_type: str = "search_document") -> list:
    """
    Embed texts using Cohere embed-english-v3 via Amazon Bedrock.
    Batches at EMBED_BATCH_SIZE (96) per call — Cohere API limit.
    input_type: 'search_document' when indexing, 'search_query' when querying.
    Returns list of 1024-dim float vectors.
    """
    client = boto3.client("bedrock-runtime", region_name=REGION)
    embeddings = []

    # Cohere max 2048 chars per text — truncate at word boundary
    texts = [t[:2048].rsplit(" ", 1)[0] if len(t) > 2048 else t for t in texts]

    for i in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = texts[i : i + EMBED_BATCH_SIZE]
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
        print(f"  [embed] batch {i // EMBED_BATCH_SIZE + 1} — {len(batch)} texts", file=sys.stderr)

    return embeddings


# ── Semantic Chunking Utilities ──────────────────────────────────────────────

def _cosine_sim(a: list, b: list) -> float:
    """Dot product of two unit-normalized Cohere vectors = cosine similarity."""
    return sum(x * y for x, y in zip(a, b))


def _find_semantic_splits(embeddings: list, threshold: float) -> list:
    """
    Return indices where a new chunk should start (similarity drop = topic change).
    Always includes 0. Example: [0, 4, 9] means chunks at [0:4], [4:9], [9:].
    """
    splits = [0]
    for i in range(len(embeddings) - 1):
        if _cosine_sim(embeddings[i], embeddings[i + 1]) < threshold:
            splits.append(i + 1)
    return splits


def _group_units_by_splits(units: list, splits: list, max_words: int) -> list:
    """
    Group text units by semantic split indices.
    If a group exceeds max_words, sub-split at word boundaries (fallback).
    Returns list of groups, each group is a list of strings.
    """
    splits_with_end = splits + [len(units)]
    groups = []
    for start, end in zip(splits_with_end, splits_with_end[1:]):
        group = units[start:end]
        total_words = sum(len(u.split()) for u in group)
        if total_words <= max_words:
            groups.append(group)
        else:
            # Sub-split by word count when a semantic group is still too large
            buf, buf_words = [], 0
            for unit in group:
                uw = len(unit.split())
                if buf_words + uw > max_words and buf:
                    groups.append(buf)
                    buf, buf_words = [unit], uw
                else:
                    buf.append(unit)
                    buf_words += uw
            if buf:
                groups.append(buf)
    return groups


def _chunk_semantic(
    sections: list,
    source_url: str,
    max_words: int,
    threshold: float,
) -> list:
    """
    Semantic chunking for web pages.

    Instead of splitting sections at fixed word counts, we:
    1. Split each section body into sentences
    2. Embed ALL sentences across ALL sections in one batched Cohere call
    3. Find topic boundaries (similarity drops) within each section
    4. Group sentences between boundaries into chunks (max_words as hard cap)

    Cost: one extra embed call per page (all sentences batched together).
    The final embedding of the chunk text happens later in write_to_db().
    """
    # Collect sentences per section
    section_sentences = []
    for heading_path, body in sections:
        sents = [
            s.strip() for s in re.split(r"(?<=[.!?])\s+", body)
            if len(s.split()) >= 5
        ]
        section_sentences.append((heading_path, sents))

    all_sentences = [s for _, sents in section_sentences for s in sents]
    if not all_sentences:
        return []

    print(f"  [semantic] embedding {len(all_sentences)} sentences for topic detection",
          file=sys.stderr)
    embeddings = embed_texts(all_sentences, input_type="search_document")

    chunks = []
    idx = 0
    emb_offset = 0

    for heading_path, sents in section_sentences:
        if not sents:
            continue

        n = len(sents)
        section_embs = embeddings[emb_offset : emb_offset + n]
        emb_offset += n

        splits = _find_semantic_splits(section_embs, threshold) if n > 1 else [0]
        groups = _group_units_by_splits(sents, splits, max_words)

        for group in groups:
            sub_body = " ".join(group)
            sub_body = re.sub(r"\s+", " ", sub_body).strip()
            if len(sub_body.split()) < _MIN_CHUNK_WORDS:
                continue
            label = heading_path if heading_path else "(intro)"
            embed_text = f"{label}\n\n{sub_body}" if heading_path else sub_body
            chunks.append({
                "source_url":   source_url,
                "heading_path": label,
                "chunk_index":  idx,
                "text":         embed_text,
                "body":         sub_body,
                "word_count":   len(sub_body.split()),
                "content_hash": hashlib.sha256(sub_body.strip().encode()).hexdigest()[:16],
            })
            idx += 1

    return chunks


# ── DB Writer ─────────────────────────────────────────────────────────────────

def write_to_db(pages: list, seed_url: str, max_pages: int, max_words: int) -> None:
    """
    For each crawled page, upsert a row in sources then upsert chunks.
    Change detection: only call Bedrock for chunks whose content_hash changed.
    Commits per page so a crash mid-crawl doesn't lose everything.
    """
    conn = get_db_connection()
    stats = {"pages_crawled": 0, "pages_skipped": 0, "chunks_upserted": 0, "chunks_deleted": 0}
    run_id = None

    try:
        # One source row for the seed domain (the website as a whole)
        seed_source_id = upsert_source(conn, seed_url, seed_url, source_type="web")
        conn.commit()

        run_id = start_crawl_run(conn, seed_source_id)
        conn.commit()

        for page in pages:
            chunks = page["chunks"]
            if not chunks:
                stats["pages_skipped"] += 1
                continue

            # Each page is its own source row
            page_source_id = upsert_source(conn, page["url"], page["title"] or page["url"], source_type="web")

            # Change detection — only embed chunks whose body changed
            existing_hashes = get_existing_chunk_hashes(conn, page_source_id)
            chunks_to_embed = [c for c in chunks if existing_hashes.get(c["chunk_index"]) != c["content_hash"]]
            chunks_unchanged = len(chunks) - len(chunks_to_embed)

            if chunks_to_embed:
                texts = [c["text"] for c in chunks_to_embed]
                embeddings = embed_texts(texts)
                for chunk, embedding in zip(chunks_to_embed, embeddings):
                    upsert_chunk(conn, page_source_id, chunk, embedding)
                    stats["chunks_upserted"] += 1

            deleted = delete_stale_chunks(conn, page_source_id, [c["chunk_index"] for c in chunks])
            stats["chunks_deleted"] += deleted
            stats["pages_crawled"] += 1

            conn.commit()
            print(
                f"  [db] {page['url']} — {len(chunks_to_embed)} embedded, "
                f"{chunks_unchanged} unchanged, {deleted} deleted",
                file=sys.stderr,
            )

        finish_crawl_run(conn, run_id, "completed", stats)
        conn.commit()
        print(f"\n[db] Done — {stats}", file=sys.stderr)

    except Exception as e:
        conn.rollback()
        if run_id:
            try:
                finish_crawl_run(conn, run_id, "failed", stats)
                conn.commit()
            except Exception:
                pass
        raise e

    finally:
        conn.close()


# ── Video URL Extraction ──────────────────────────────────────────────────────

_VIDEO_PATTERNS: list = [
    (r'youtube\.com/embed/([a-zA-Z0-9_-]{11})',    'https://www.youtube.com/watch?v={}'),
    (r'youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})', 'https://www.youtube.com/watch?v={}'),
    (r'youtu\.be/([a-zA-Z0-9_-]{11})',             'https://www.youtube.com/watch?v={}'),
    (r'vimeo\.com/(?:video/)?(\d{6,})',            'https://vimeo.com/{}'),
]
_URL_ATTRS = ('src', 'href', 'data-src', 'data-url', 'data-video-url')


def extract_video_urls(soup) -> list:
    seen: set = set()
    urls: list = []
    for tag in soup.find_all(True):
        for attr in _URL_ATTRS:
            value = tag.get(attr) or ""
            for pattern, template in _VIDEO_PATTERNS:
                m = re.search(pattern, value)
                if m:
                    canonical = template.format(m.group(1))
                    if canonical not in seen:
                        seen.add(canonical)
                        urls.append(canonical)
    return urls


def extract_video_urls_from_raw(html: str) -> list:
    """
    Scan raw HTML string for video patterns — catches URLs embedded in JS
    bundles, JSON data blobs, and inline scripts that BeautifulSoup never sees.
    """
    seen: set = set()
    urls: list = []
    for pattern, template in _VIDEO_PATTERNS:
        for m in re.finditer(pattern, html):
            canonical = template.format(m.group(1))
            if canonical not in seen:
                seen.add(canonical)
                urls.append(canonical)
    return urls


# ── Extractor ─────────────────────────────────────────────────────────────────

def extract_content(html: str) -> dict:
    xml_content = trafilatura.extract(
        html,
        include_tables=True,
        include_formatting=True,
        include_links=True,
        output_format="xml",
        no_fallback=False,
    )
    meta = trafilatura.extract_metadata(html)
    title = (meta.title or "").strip() if meta else ""
    return {"title": title, "xml": xml_content}


# ── Chunker ───────────────────────────────────────────────────────────────────

_MIN_CHUNK_WORDS = 30


def chunk_content(xml_str, source_url: str, max_words: int = 650,
                  use_semantic: bool = False, semantic_threshold: float = 0.6) -> list:
    if not xml_str:
        return []
    sections = _parse_xml_sections(xml_str)
    if not sections:
        return _chunk_paragraphs(_xml_to_plain(xml_str), source_url, max_words)

    if use_semantic:
        return _chunk_semantic(sections, source_url, max_words, semantic_threshold)

    chunks = []
    idx = 0
    for heading_path, body in sections:
        for sub_body, part_suffix in _split_long(body, max_words, overlap_sentences=2):
            if len(sub_body.split()) < _MIN_CHUNK_WORDS:
                continue
            label = f"{heading_path}{part_suffix}" if heading_path else f"(intro){part_suffix}"
            embed_text = f"{label}\n\n{sub_body}" if heading_path else sub_body
            chunks.append({
                "source_url": source_url,
                "heading_path": label,
                "chunk_index": idx,
                "text": embed_text,
                "body": sub_body,
                "word_count": len(sub_body.split()),
                "content_hash": hashlib.sha256(sub_body.strip().encode()).hexdigest()[:16],
            })
            idx += 1
    return chunks


def _parse_xml_sections(xml_str: str):
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return None

    main = root.find("main") or root
    sections = []
    heading_stack: list = []
    current_blocks: list = []

    def flush():
        body = "\n".join(b for b in current_blocks if b.strip())
        if body and len(body.split()) >= _MIN_CHUNK_WORDS:
            sections.append((" > ".join(heading_stack), body))

    for elem in main:
        tag = elem.tag
        if tag == "head":
            flush()
            current_blocks = []
            m = re.match(r"h(\d)", elem.get("rend", ""))
            level = int(m.group(1)) if m else 1
            text = (elem.text or "").strip()
            if text:
                heading_stack = heading_stack[: level - 1] + [text]
        elif tag == "p":
            if elem.text and elem.text.strip():
                current_blocks.append(elem.text.strip())
        elif tag == "list":
            items = [f"- {(item.text or '').strip()}" for item in elem.findall("item") if (item.text or "").strip()]
            if items:
                current_blocks.append("\n".join(items))
        elif tag == "table":
            rows = []
            for row in elem.findall("row"):
                cells = [(c.text or "").strip() for c in row.findall("cell")]
                row_text = " | ".join(c for c in cells if c)
                if row_text:
                    rows.append(row_text)
            if rows:
                current_blocks.append("\n".join(rows))

    flush()
    return sections or None


def _xml_to_plain(xml_str: str) -> str:
    try:
        root = ET.fromstring(xml_str)
        return " ".join((t or "").strip() for t in root.itertext() if (t or "").strip())
    except ET.ParseError:
        return re.sub(r"<[^>]+>", " ", xml_str)


def _chunk_paragraphs(text: str, source_url: str, max_words: int) -> list:
    paras = [p.strip() for p in re.split(r"\n{2,}", text) if len(p.split()) >= 10]
    if not paras:
        return []

    chunks: list = []
    idx = 0
    buf: list = []

    def emit():
        nonlocal idx
        body = " ".join(buf)
        if len(buf) >= _MIN_CHUNK_WORDS:
            chunks.append({
                "source_url": source_url,
                "heading_path": "(no heading)",
                "chunk_index": idx,
                "text": body,
                "body": body,
                "word_count": len(buf),
                "content_hash": hashlib.sha256(body.strip().encode()).hexdigest()[:16],
            })
            idx += 1

    for para in paras:
        para_words = para.split()
        if len(buf) + len(para_words) > max_words and buf:
            emit()
            buf = para_words
        else:
            buf.extend(para_words)
    if buf:
        emit()
    return chunks


def _split_long(text: str, max_words: int, overlap_sentences: int = 2) -> list:
    if len(text.split()) <= max_words:
        return [(text, "")]

    sentences = re.split(r"(?<=[.!?])\s+", text)
    parts: list = []
    buf_sents: list = []
    part_n = 1

    for sent in sentences:
        buf_words = sum(len(s.split()) for s in buf_sents)
        if buf_words + len(sent.split()) > max_words and buf_sents:
            parts.append((" ".join(buf_sents), f" [part {part_n}]"))
            part_n += 1
            buf_sents = buf_sents[-overlap_sentences:] + [sent]
        else:
            buf_sents.append(sent)

    if buf_sents:
        parts.append((" ".join(buf_sents), f" [part {part_n}]" if parts else ""))
    return parts


# ── Crawler ───────────────────────────────────────────────────────────────────

async def crawl(seed_url: str, max_pages: int, max_words: int,
               use_semantic: bool = False, semantic_threshold: float = 0.6):
    pages: list = []
    discovered_urls: set = set()
    crawler = PlaywrightCrawler(max_requests_per_crawl=max_pages, headless=True)

    @crawler.router.default_handler
    async def handler(ctx: PlaywrightCrawlingContext) -> None:
        url = ctx.request.url
        discovered_urls.add(url)

        # Wait for JS to fully render (important for Wix SPAs)
        await ctx.page.wait_for_load_state("networkidle")
        await ctx.page.wait_for_timeout(2000)

        html = await ctx.page.content()
        soup = BeautifulSoup(html, "html.parser")

         # debug
        print(f"  [debug] {url} — discovered: {len(discovered_urls)}", file=sys.stderr)
        view_ids_debug = re.findall(r'[?&]view=([a-f0-9-]{36})', html)
        print(f"  [debug] view UUIDs found in HTML: {view_ids_debug[:5]}", file=sys.stderr)

        # Extract video URLs from fully-rendered HTML
        video_urls = extract_video_urls(soup)

        # Also scan raw HTML for video iframes that BeautifulSoup may miss
        raw_video_urls = extract_video_urls_from_raw(html)
        video_urls = list(dict.fromkeys(video_urls + raw_video_urls))  # dedupe, preserve order

        page_links = [a.get("href", "") for a in soup.find_all("a", href=True)]

        # Enqueue Wix resource detail pages — these use ?view=<uuid> and are
        # only discoverable by scraping UUIDs from the raw HTML, not via <a href>
        view_ids = re.findall(r'[?&]view=([a-f0-9-]{36})', html)
        if view_ids:
            resource_urls = [f"https://{ctx.page.url.split('/')[2]}/resource?view={vid}" for vid in set(view_ids)]
            await ctx.add_requests(resource_urls)
            print(f"  [wix]  {url} — enqueued {len(resource_urls)} resource detail page(s)", file=sys.stderr)

        extracted = extract_content(html)
        chunks = chunk_content(extracted["xml"], url, max_words,
                               use_semantic=use_semantic,
                               semantic_threshold=semantic_threshold)

        if not chunks and not video_urls:
            print(f"  [skip] {url} — no content", file=sys.stderr)
        else:
            pages.append({
                "url": url,
                "title": extracted["title"],
                "chunk_count": len(chunks),
                "video_urls": video_urls,
                "internal_links_found": len([l for l in page_links if l.startswith("/") or seed_url in l]),
                "chunks": chunks,
            })
            video_note = f", {len(video_urls)} video URL(s)" if video_urls else ""
            print(f"  [ok]   {url} — {len(chunks)} chunk(s){video_note}", file=sys.stderr)

        await ctx.enqueue_links(strategy="same-domain", selector="a[href]")

    await crawler.run([seed_url])
    return pages, discovered_urls




# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Crawl + chunk + embed + write to pgvector DB")
    parser.add_argument("seed_url", help="Starting URL")
    parser.add_argument("--max-pages", type=int, default=50)
    parser.add_argument("--max-words", type=int, default=650, help="Max words per chunk before splitting")
    parser.add_argument("--output",   default="crawl_output.json")
    parser.add_argument("--write-db", action="store_true", help="Embed chunks and write to database")
    parser.add_argument("--semantic", action="store_true",
                        help="Use semantic chunking (embed sentences to detect topic boundaries)")
    parser.add_argument("--semantic-threshold", type=float, default=0.6,
                        help="Cosine similarity threshold for topic boundary detection (default 0.6)")
    args = parser.parse_args()

    if args.semantic:
        print(f"Semantic chunking enabled (threshold={args.semantic_threshold})", file=sys.stderr)
    print(f"Crawling {args.seed_url} (max {args.max_pages} pages)...", file=sys.stderr)
    pages, discovered_urls = asyncio.run(
        crawl(args.seed_url, args.max_pages, args.max_words,
              use_semantic=args.semantic,
              semantic_threshold=args.semantic_threshold)
    )

    all_chunks = [c for p in pages for c in p["chunks"]]
    all_videos = [v for p in pages for v in p["video_urls"]]
    word_counts = [c["word_count"] for c in all_chunks]
    pages_fallback = sum(
        1 for p in pages
        if p["chunks"] and all(c["heading_path"] in ("(no heading)", "(intro)") for c in p["chunks"])
    )

    crawled_urls = {p["url"] for p in pages}
    skipped_urls = sorted(discovered_urls - crawled_urls)

    result = {
        "seed_url": args.seed_url,
        "pages_crawled": len(pages),
        "pages_skipped_no_content": len(skipped_urls),
        "total_chunks": len(all_chunks),
        "total_video_urls": len(set(all_videos)),
        "chunk_stats": {
            "avg_words": round(sum(word_counts) / len(word_counts), 1) if word_counts else 0,
            "min_words": min(word_counts) if word_counts else 0,
            "max_words": max(word_counts) if word_counts else 0,
            "pages_using_paragraph_fallback": pages_fallback,
        },
        "all_video_urls": sorted(set(all_videos)),
        "skipped_urls": skipped_urls,
        "pages": pages,
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(
        f"\nDone: {len(pages)} pages, {len(all_chunks)} chunks, "
        f"{len(set(all_videos))} unique video URL(s) → {args.output}",
        file=sys.stderr,
    )
    if word_counts:
        s = result["chunk_stats"]
        print(
            f"Chunk stats: avg={s['avg_words']} words, min={s['min_words']}, "
            f"max={s['max_words']}, paragraph_fallback_pages={s['pages_using_paragraph_fallback']}",
            file=sys.stderr,
        )

    if args.write_db:
        print("\nWriting embeddings to database...", file=sys.stderr)
        write_to_db(pages, args.seed_url, args.max_pages, args.max_words)


if __name__ == "__main__":
    main()
