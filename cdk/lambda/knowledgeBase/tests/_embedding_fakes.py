"""
Test doubles for the embedding-space jobs (reembed_space, validate_space, cutover,
embedding_admin). No test here touches AWS or a real database.

FakeDb is a small transactional model of exactly the statements those modules run: it
keeps a committed state and a working copy, applies each recognised statement to the
working copy, and swaps on commit / rollback. That is what lets the tests assert the
properties that matter (the pointer flip is atomic, a failed batch leaves no half
write, the lock is released) rather than just the SQL text. A statement it does not
recognise raises, so a new query in the code under test cannot slip through silently.

ScriptedConnection is the simple fragment -> rows kind of fake used by the admin tests.
"""

import copy
import hashlib
import re

NIL = "00000000-0000-0000-0000-000000000000"


def md5(text):
    return hashlib.md5(text.encode()).hexdigest()


def norm(sql):
    return " ".join(sql.split())


class FakeCursor:
    def __init__(self, db):
        self.db = db
        self.rows = []
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.db.log.append(("sql", norm(sql), params, self.db.txn_id))
        for fragment, error in list(self.db.failures):
            if fragment in norm(sql):
                self.db.failures.remove((fragment, error))
                raise error
        self.rows, self.rowcount = self.db.handle(norm(sql), params or ())

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class FakeDb:
    """Transactional state model. See the module docstring."""

    def __init__(self, **overrides):
        state = {
            "chunks": {},          # chunk_id -> embed_text
            "vectors": {},         # (space_id, chunk_id) -> embed_hash
            "spaces": {},          # space_id -> {"status", "price", ...}
            "pointer": None,
            "lock": {"locked": False, "job_id": None, "expired": False},
            "running_ingestion": 0,
            "job": None,
        }
        state.update(overrides)
        self.committed = state
        self.tx = copy.deepcopy(state)
        self.log = []
        self.failures = []
        self.txn_id = 0
        self.commits = 0
        self.rollbacks = 0
        self.price = None

    # connection API
    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.log.append(("commit", self.txn_id))
        self.committed = copy.deepcopy(self.tx)
        self.commits += 1
        self.txn_id += 1

    def rollback(self):
        self.log.append(("rollback", self.txn_id))
        self.tx = copy.deepcopy(self.committed)
        self.rollbacks += 1
        self.txn_id += 1

    # helpers for tests
    def fail_next(self, fragment, error):
        self.failures.append((fragment, error))

    @property
    def job(self):
        return self.tx["job"]

    def statements(self, fragment):
        return [e for e in self.log if e[0] == "sql" and fragment in e[1]]

    def job_row(self):
        j = self.tx["job"]
        return (
            j["id"], j["space_id"], j["mode"], j["status"], j.get("total_chunks"), j.get("processed", 0),
            j.get("failed", 0), j.get("est_tokens"), j.get("est_cost_usd"), j.get("est_seconds"),
            j.get("price_configured", False), j.get("cursor"), j.get("continuation", 0),
            j.get("current_step"), j.get("steps", []), j.get("report"), j.get("last_error"),
            j.get("requested_by"), None, None, None, None,
        )

    def remaining(self, space_id):
        return sorted(
            cid for cid, text in self.tx["chunks"].items()
            if self.tx["vectors"].get((space_id, cid)) != md5(text)
        )

    # statement handlers
    def handle(self, n, p):  # noqa: C901 - one flat dispatch on purpose
        t = self.tx
        job = t["job"]

        # ── job row ──
        if n.startswith("SELECT") and "FROM embedding_jobs WHERE id = %s::uuid" in n:
            return ([self.job_row()] if job and job["id"] == p[0] else []), 1
        if "UPDATE embedding_jobs SET status = 'running'" in n:
            job["status"] = "running"
            job["continuation"] = max(job.get("continuation", 0), p[0])
            return [], 1
        if "UPDATE embedding_jobs SET processed = processed + %s, cursor = %s" in n:
            job["processed"] = job.get("processed", 0) + p[0]
            job["cursor"] = p[1]
            return [], 1
        if "UPDATE embedding_jobs SET cursor = NULL" in n:
            job["cursor"] = None
            return [], 1
        if "UPDATE embedding_jobs SET total_chunks = %s" in n:
            job["total_chunks"] = p[0]
            return [], 1
        if "UPDATE embedding_jobs SET continuation = %s" in n:
            job["continuation"] = p[0]
            return [], 1
        if "UPDATE embedding_jobs SET steps = %s::jsonb" in n:
            import json
            job["steps"] = json.loads(p[0])
            job["current_step"] = p[1]
            job["report"] = json.loads(p[2])
            return [], 1
        if "UPDATE embedding_jobs SET updated_at = now()" in n:
            return [], 1
        if "UPDATE embedding_jobs SET status = 'succeeded', total_chunks = %s" in n:
            rows, tokens, cost, seconds, priced, report, error, _id = p
            import json
            job.update(status="succeeded", total_chunks=rows, est_tokens=tokens, est_cost_usd=cost,
                       est_seconds=seconds, price_configured=priced, report=json.loads(report),
                       last_error=error)
            return [], 1
        if "UPDATE embedding_jobs SET status = %s, finished_at = now()" in n:
            import json
            status, error, report, _id = p
            job["status"] = status
            if error is not None:
                job["last_error"] = error
            if report is not None:
                job["report"] = json.loads(report)
            return [], 1

        # ── chunk work list ──
        if "SELECT c.id::text, c.embed_text, md5(c.embed_text)" in n:
            space_id, cursor, limit = p
            rows = [(cid, t["chunks"][cid], md5(t["chunks"][cid]))
                    for cid in self.remaining(space_id) if cid > cursor][:limit]
            return rows, len(rows)
        if "INSERT INTO chunk_embeddings" in n and "SELECT c.id, %s::uuid, %s::vector, %s, now()" in n:
            space_id, _literal, embed_hash, chunk_id = p
            if chunk_id in t["chunks"]:
                t["vectors"][(space_id, chunk_id)] = embed_hash
                return [], 1
            return [], 0
        if "SELECT count(*), COALESCE(sum(LEAST(length(c.embed_text), %s)), 0)" in n:
            max_chars, space_id = p
            ids = self.remaining(space_id)
            return [(len(ids), sum(min(len(t["chunks"][i]), max_chars) for i in ids))], 1
        if n.startswith("SELECT count(*) FROM chunks c LEFT JOIN chunk_embeddings"):
            return [(len(self.remaining(p[0])),)], 1
        if n.startswith("SELECT c.embed_text FROM chunks c"):
            space_id, limit = p
            return [(t["chunks"][i],) for i in self.remaining(space_id)[:limit]], 1
        if "SELECT price_per_1m_tokens FROM embedding_spaces" in n:
            return [(self.price,)], 1

        # ── lock and pointer ──
        if "UPDATE embedding_active_space SET cutover_locked = true" in n:
            job_id = p[0]
            lock = t["lock"]
            if (not lock["locked"]) or lock["job_id"] == job_id or lock["expired"]:
                t["lock"] = {"locked": True, "job_id": job_id, "expired": False}
                return [], 1
            return [], 0
        if "UPDATE embedding_active_space SET cutover_locked_at = now()" in n:
            return [], 1 if t["lock"]["locked"] and t["lock"]["job_id"] == p[0] else 0
        if "UPDATE embedding_active_space SET cutover_locked = false" in n:
            if t["lock"]["job_id"] == p[0]:
                t["lock"] = {"locked": False, "job_id": None, "expired": False}
                return [], 1
            return [], 0
        if n.startswith("SELECT space_id::text FROM embedding_active_space"):
            return [(t["pointer"],)], 1
        if "FROM ingestion_runs" in n:
            return [(t["running_ingestion"],)], 1

        # ── flip ──
        if "UPDATE embedding_spaces SET status = 'retired'" in n:
            space = t["spaces"].get(p[0])
            if space and space["status"] == "active":
                space["status"] = "retired"
                space["retired_at"] = "now"
                return [], 1
            return [], 0
        if "UPDATE embedding_spaces SET status = 'active'" in n:
            space = t["spaces"].get(p[0])
            if space and space["status"] == p[1]:
                space["status"] = "active"
                space["activated_at"] = "now"
                space["retired_at"] = None
                return [], 1
            return [], 0
        if "UPDATE embedding_active_space SET space_id" in n:
            if t["pointer"] == p[1]:
                t["pointer"] = p[0]
                return [], 1
            return [], 0

        raise AssertionError(f"FakeDb: unhandled statement: {n[:160]}")


class ScriptedCursor:
    def __init__(self, conn):
        self.conn = conn
        self.rows = []
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        text = norm(sql)
        self.conn.executed.append((text, params))
        for fragment, error in list(self.conn.failures):
            if fragment in text:
                self.conn.failures.remove((fragment, error))
                raise error
        self.rows, self.rowcount = self.conn.respond(text, params)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class ScriptedConnection:
    """
    `responses`: fragment -> rows, or a callable (params) -> rows, or a list of row-lists
    consumed one per matching statement (the last one repeats). `rowcounts`: fragment -> int.
    """

    def __init__(self, responses=None, rowcounts=None):
        self.responses = dict(responses or {})
        self.rowcounts = dict(rowcounts or {})
        self.executed = []
        self.commits = 0
        self.rollbacks = 0
        self.failures = []

    def cursor(self):
        return ScriptedCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def fail_next(self, fragment, error):
        self.failures.append((fragment, error))

    def respond(self, text, params):
        rows, count = [], 0
        for fragment, value in self.responses.items():
            if fragment in text:
                if callable(value):
                    rows = value(params)
                elif value and isinstance(value[0], list):
                    rows = value[0] if len(value) == 1 else value.pop(0)
                else:
                    rows = value
                break
        for fragment, value in self.rowcounts.items():
            if fragment in text:
                count = value
                break
        return rows, count

    def sql_with(self, fragment):
        return [(sql, p) for sql, p in self.executed if fragment in sql]


class Context:
    """Lambda context stand-in: remaining time shrinks by `step` ms per call."""

    def __init__(self, remaining_ms=600_000, step_ms=0):
        self.remaining_ms = remaining_ms
        self.step_ms = step_ms

    def get_remaining_time_in_millis(self):
        value = self.remaining_ms
        self.remaining_ms -= self.step_ms
        return value


def make_job(job_id, space_id, mode, **extra):
    job = {
        "id": job_id, "space_id": space_id, "mode": mode, "status": "queued",
        "processed": 0, "continuation": 0, "steps": [], "report": None,
    }
    job.update(extra)
    return job
