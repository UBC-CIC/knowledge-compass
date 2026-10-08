"""
Helper for docker_migration_check.js (a manual harness, not a unit test).

Imports the real writer and retrieval modules, calls their SQL-building
functions with a recording cursor, and prints the statements and parameters as
JSON so the harness can run the EXACT SQL against a real Postgres. Nothing here
connects to a database or to AWS.

Input (stdin, JSON):
  {"mode": "kb" | "tg" | "containers", "source_id": ..., "space_id": ..., "dims": N,
   "text": ..., "index": N, "vector": [floats]}
Output (stdout, JSON): [{"name": ..., "sql": ..., "params": [...]}, ...]
"""

import importlib.util
import json
import os
import sys
import types
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
LAMBDA = os.path.abspath(os.path.join(HERE, "..", ".."))
CONTAINERS = os.path.abspath(os.path.join(LAMBDA, "..", "containers"))


class Cursor:
    def __init__(self, conn):
        self.conn = conn
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.log.append({"name": self.conn.next_name, "sql": sql, "params": list(params) if params is not None else []})

    def fetchall(self):
        return []

    def fetchone(self):
        return None


class Conn:
    def __init__(self):
        self.log = []
        self.next_name = ""

    def cursor(self):
        return Cursor(self)


def vector_literal(vector):
    return "[" + ",".join(str(x) for x in vector) + "]"


def run_kb(req):
    sys.path.append(os.path.join(LAMBDA, "knowledgeBase"))
    os.environ.setdefault("REGION", "us-east-1")
    os.environ["AWS_ACCESS_KEY_ID"] = "testing"
    os.environ["AWS_SECRET_ACCESS_KEY"] = "testing"
    try:
        import docx  # noqa: F401
    except Exception:  # noqa: BLE001 - the vendored lxml is Linux-only
        stub = types.ModuleType("docx")
        stub.Document = object
        sys.modules["docx"] = stub
    from helpers import process_document_batch as batch

    chunk = {"chunk_index": req["index"], "heading_path": "H", "text": req["text"], "body": req["text"],
             "word_count": len(req["text"].split()), "content_hash": f"ch-{req['index']}", "metadata": {}}
    conn = Conn()
    for name, call in (
        ("kb_existing", lambda: batch._existing_chunk_states(conn, req["source_id"], req["space_id"])),
        ("kb_reusable", lambda: batch._reusable_embeddings(conn, req["source_id"], [chunk], req["space_id"])),
        ("kb_global", lambda: batch._globally_reusable_embeddings(conn, [chunk], req["space_id"])),
        ("kb_upsert", lambda: batch._upsert_chunk(conn, req["source_id"], chunk, req["vector"], req["space_id"])),
    ):
        conn.next_name = name
        call()
    return conn.log


def run_tg(req):
    sys.path.insert(0, os.path.join(LAMBDA, "textGeneration"))
    from helpers import guideline_retrieval, retrieval_core

    space = {"id": req["space_id"], "dimensions": req["dims"]}
    vec = vector_literal(req["vector"])
    return [
        {"name": "tg_standard", "sql": retrieval_core.build_standard_sql(space), "params": [vec, vec, 5, 0]},
        {"name": "tg_guideline", "sql": guideline_retrieval.build_candidate_sql(space), "params": [vec, vec, 40]},
    ]


def _stub(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    return module


def _load_container(name, rel):
    stubs = {
        "psycopg2": _stub("psycopg2"),
        "crawlee": _stub("crawlee"),
        "crawlee.crawlers": _stub("crawlee.crawlers", PlaywrightCrawler=object, PlaywrightCrawlingContext=object),
        "trafilatura": _stub("trafilatura"),
        "bs4": _stub("bs4", BeautifulSoup=object),
    }
    path = os.path.join(CONTAINERS, *rel.split("/"))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, CONTAINERS)
    try:
        with mock.patch.dict(sys.modules, stubs), mock.patch.dict(os.environ, {"AWS_DEFAULT_REGION": "us-east-1"}):
            spec.loader.exec_module(module)
    finally:
        sys.path.remove(CONTAINERS)
    return module


def run_containers(req):
    conn = Conn()
    crawler = _load_container("dump_crawler", "crawler/crawler.py")
    transcriber = _load_container("dump_transcriber", "transcriber/transcrbe.py")
    text = req["text"]
    crawler_chunk = {"chunk_index": req["index"], "heading_path": "H", "text": text, "body": text,
                     "word_count": len(text.split()), "content_hash": f"ch-{req['index']}"}
    transcriber_chunk = {"chunk_index": req["index"], "chunk_start": "00:00:01.000", "chunk_end": "00:00:09.000",
                         "embed_text": text, "body": text, "word_count": len(text.split()),
                         "content_hash": f"ch-{req['index']}"}
    for name, call in (
        ("crawler_existing", lambda: crawler.get_existing_chunk_hashes(conn, req["source_id"], req["space_id"])),
        ("crawler_upsert", lambda: crawler.upsert_chunk(conn, req["source_id"], crawler_chunk, req["vector"], req["space_id"])),
        ("transcriber_existing", lambda: transcriber.get_existing_chunk_hashes(conn, req["source_id"], req["space_id"])),
        ("transcriber_upsert", lambda: transcriber.upsert_chunk(conn, req["source_id"], transcriber_chunk, req["vector"], req["space_id"])),
    ):
        conn.next_name = name
        call()
    return conn.log


def main():
    req = json.load(sys.stdin)
    out = {"kb": run_kb, "tg": run_tg, "containers": run_containers}[req["mode"]](req)
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
