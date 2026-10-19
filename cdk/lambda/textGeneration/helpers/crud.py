
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from helpers.prompt_data import MAX_GUIDE_LABEL_CHARS, guide_state_key

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def get_exchange_count(chat_session_id: str, db_connection) -> int:
    """
    Counts the number of exchanges (User + AI pairs) in a session.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM chat_messages WHERE chat_session_id = %s", (chat_session_id,))
            msg_count = cur.fetchone()[0]
            # Each exchange is roughly 2 messages (User + AI)
            exchange_count = msg_count // 2
            return exchange_count
    except Exception as e:
        logger.error(f"Could not count history: {e}")
        return 0

def fetch_recent_messages(
    db_connection,
    chat_session_id: str,
) -> List[Dict[str, Any]]:    
    """
    Fetch the most recent messages for a chat session, returned oldest->newest.

    The inner query selects the latest N messages (DESC + LIMIT); the outer
    query restores chronological order for the Bedrock conversation.
    """
    with db_connection.cursor() as cur:
        cur.execute(
            """
            SELECT sender, content, created_at
            FROM (
                SELECT sender, content, created_at
                FROM chat_messages
                WHERE chat_session_id = %s
                ORDER BY created_at DESC
                LIMIT %s
            ) AS recent
            ORDER BY created_at ASC
            """,
            (chat_session_id, 20)
        )
        rows = cur.fetchall()

    messages = []
    for sender, content, created_at in rows:
        messages.append({
            "sender": sender,          # 'user' or 'AI'
            "content": content,
            "created_at": created_at.isoformat() if created_at else None
        })

    # Bedrock Converse requires the conversation to start with a user turn.
    # A sliding window can begin on an AI message, so drop any leading ones.
    while messages and messages[0]["sender"] != "user":
        messages.pop(0)

    return messages

# users and chat_sessions rows are never created here: only POST /user and
# POST /chat_sessions create them, so generation requires both to exist.

def insert_message(
    db_connection,
    chat_session_id: str,
    sender: str,
    content: str,
    sources: Optional[List[Dict[str, Any]]] = None,
    warning: Optional[str] = None
) -> str:
    message_id = str(uuid.uuid4())
    sources_json = json.dumps(sources or [])
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chat_messages (id, chat_session_id, sender, content, sources, warning, created_at)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s, NOW())
                """,
                (message_id, chat_session_id, sender, content, sources_json, warning)
            )
    except Exception as e:
        logger.error(f"insert_message failed: {e}")
        raise e
    return message_id

def update_last_active_session(db_connection, chat_session_id: str) -> None:
    try:
        with db_connection.cursor() as cur:
            cur.execute("UPDATE chat_sessions SET last_active_at = NOW() WHERE id = %s", (chat_session_id,))
    except Exception as e:
        logger.error(f"update_last_active_session failed: {e}")

def get_session_title(db_connection, chat_session_id: str) -> Optional[str]:
    try:
        with db_connection.cursor() as cur:
            cur.execute("SELECT title FROM chat_sessions WHERE id = %s", (chat_session_id,))
            row = cur.fetchone()
            return row[0] if row else None
    except Exception as e:
        logger.error(f"get_session_title failed: {e}")
        return None

def update_session_title(db_connection, chat_session_id: str, title: str) -> None:
    with db_connection.cursor() as cur:
        cur.execute(
            "UPDATE chat_sessions SET title = %s WHERE id = %s",
            (title, chat_session_id)
        )

def fetch_system_config(db_connection) -> Dict[str, Any]:
    """
    Fetches system_messages (latest active version per type) and system_settings.
    """
    config = {'messages': {}, 'settings': {}}
    try:
        # Fetch System Messages
        # DISTINCT ON (type) ensures we get one row per type.
        # ORDER BY type, version DESC ensure that row is the highest version.
        with db_connection.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT ON (type) type, content
                FROM system_messages
                WHERE is_active = true
                ORDER BY type, version DESC
            """)
            rows = cur.fetchall()
            for row in rows:
                config['messages'][row[0]] = row[1]

        # Fetch System Settings. to_jsonb(row) keeps this query valid whether or
        # not newer columns (e.g. routing_mode from migration 022) exist yet.
        with db_connection.cursor() as cur:
            cur.execute("""
                SELECT to_jsonb(s)
                FROM system_settings s
                ORDER BY s.updated_at DESC
                LIMIT 1
            """)
            row = cur.fetchone()
            if row and isinstance(row[0], dict):
                s = row[0]

                # NULL columns become None and are dropped below, so the
                # recommended defaults in helpers/config.py apply (one source).
                def _float(key):
                    value = s.get(key)
                    return float(value) if value is not None else None

                settings = {
                    'max_messages_per_day': s.get('max_messages_per_day'),
                    'min_messages_before_suggest': s.get('min_messages_before_suggest'),
                    'max_characters_per_user_message': s.get('max_characters_per_user_message'),
                    'max_characters_per_day': s.get('max_characters_per_day'),
                    'max_messages_per_day_global': s.get('max_messages_per_day_global'),
                    'max_characters_per_ai_message': s.get('max_characters_per_ai_message'),
                    'temperature': _float('temperature'),
                    'top_p': _float('top_p'),
                    'support_score_threshold': _float('support_score_threshold'),
                    'scope_alignment_score_threshold': _float('scope_alignment_score_threshold'),
                    'grounded_threshold': _float('grounded_threshold'),
                    'partially_grounded_threshold': _float('partially_grounded_threshold'),
                }
                if s.get('routing_mode') in ('fixed', 'dynamic'):
                    settings['routing_mode'] = s['routing_mode']
                if isinstance(s.get('min_exchanges_before_answer'), int):
                    settings['min_exchanges_before_answer'] = s['min_exchanges_before_answer']
                # Drop NULL columns so config.py keeps its defaults.
                config['settings'] = {k: v for k, v in settings.items() if v is not None}
    except Exception as e:
        logger.error(f"fetch_system_config failed: {e}")
        # Return what we have (empty or partial)
    return config


SERVICE_STATUSES = ("normal", "banner", "read_only")
# Its own short cache (not config.CONFIG_TTL_SECONDS, 300 s): ops flip this flag to stop
# or resume chat, so the change has to reach every warm Lambda within seconds.
SERVICE_STATUS_TTL_SECONDS = 30
_service_status_cache: Dict[str, Any] = {"value": None, "at": 0.0}
_service_status_clock = time.monotonic  # module-level so tests can replace it


def fetch_service_status(db_connection) -> Dict[str, Any]:
    """
    Maintenance banner / read-only flag (migration 034): {"status", "message"}.

    status is 'normal', 'banner' or 'read_only'. Cached for SERVICE_STATUS_TTL_SECONDS.

    Unlike fetch_active_space this deliberately FALLS BACK to normal on any error: a failed
    status read must never take chat down, and the worst case is that a read-only switch
    takes effect a little late. The failure is logged (class name only) as a WARNING and
    is not cached, so the next call tries again.
    """
    now = _service_status_clock()
    cached = _service_status_cache["value"]
    if cached is not None and now - _service_status_cache["at"] < SERVICE_STATUS_TTL_SECONDS:
        return dict(cached)
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                "SELECT service_status, service_message FROM system_settings "
                "ORDER BY updated_at DESC NULLS LAST LIMIT 1"
            )
            row = cur.fetchone()
    except Exception as e:
        logger.warning(f"fetch_service_status failed, treating the service as normal: {type(e).__name__}")
        try:
            db_connection.rollback()
        except Exception:
            pass
        return {"status": "normal", "message": None}
    status = row[0] if row and row[0] in SERVICE_STATUSES else "normal"
    message = row[1] if row and isinstance(row[1], str) and row[1].strip() else None
    value = {"status": status, "message": message}
    _service_status_cache["value"] = value
    _service_status_cache["at"] = now
    return dict(value)


GUIDELINE_MODES = ("standard", "guideline")


def fetch_guideline_config(db_connection) -> Dict[str, Any]:
    """
    Guideline mode settings (migration 031): {mode, outline}.

    outline lists the auto-detected situations of every `ready` guideline
    document as [{document_id, file_name, section_key, label}], using the admin
    label override when set. Falls back to {"mode": "standard", "outline": []}
    on any error (for example before migration 031 has run); the transaction is
    rolled back so later queries on the shared connection still work.
    """
    result: Dict[str, Any] = {"mode": "standard", "outline": []}
    try:
        with db_connection.cursor() as cur:
            cur.execute("SELECT prompt_mode FROM guideline_config ORDER BY id LIMIT 1")
            row = cur.fetchone()
            if row and row[0] in GUIDELINE_MODES:
                result["mode"] = row[0]

            cur.execute("""
                SELECT d.id::text, d.file_name, s.section_key,
                       COALESCE(NULLIF(s.label_override, ''), s.auto_label)
                FROM guideline_sections s
                JOIN guideline_documents d ON d.id = s.document_id
                WHERE d.status = 'ready'
                ORDER BY d.created_at, d.id, s.sort_order, s.section_key
            """)
            result["outline"] = [
                {
                    "document_id": r[0],
                    "file_name": r[1],
                    "section_key": r[2],
                    "label": r[3],
                }
                for r in cur.fetchall()
            ]
    except Exception as e:
        logger.error(f"fetch_guideline_config failed: {type(e).__name__}")
        try:
            db_connection.rollback()
        except Exception:
            pass
        return {"mode": "standard", "outline": []}
    return result


_ACTIVE_SPACE_COLUMNS = """
    s.id::text, s.name, s.provider, s.model_id, s.invoke_target, s.dimensions,
    s.version, s.status, s.min_score, s.split_threshold, s.settings"""


def fetch_active_space(db_connection, space_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    The embedding space retrieval should use (migration 032), as a dict:
    id, name, provider, model_id, invoke_target, dimensions, version, status,
    min_score, split_threshold, settings, cutover_locked.

    Without `space_id` this follows the single-row `embedding_active_space`
    pointer. With `space_id` it returns that space (any status except
    `purged`), which is how validation searches a space that is not yet active.

    Unlike fetch_guideline_config this deliberately does NOT fall back to
    defaults on error: serving answers from a different model than the one the
    stored vectors were made with silently returns wrong results, so a missing
    pointer returns None and a SQL error is rolled back and re-raised for the
    caller to fail loud.
    """
    try:
        with db_connection.cursor() as cur:
            if space_id is None:
                cur.execute(
                    f"""SELECT {_ACTIVE_SPACE_COLUMNS}, a.cutover_locked
                        FROM embedding_active_space a
                        JOIN embedding_spaces s ON s.id = a.space_id
                        WHERE a.id = 1"""
                )
            else:
                cur.execute(
                    f"""SELECT {_ACTIVE_SPACE_COLUMNS}, COALESCE(a.cutover_locked, false)
                        FROM embedding_spaces s
                        LEFT JOIN embedding_active_space a ON a.id = 1
                        WHERE s.id = %s AND s.status <> 'purged'""",
                    (str(space_id),),
                )
            row = cur.fetchone()
    except Exception:
        try:
            db_connection.rollback()
        except Exception:
            pass
        raise
    if not row:
        return None
    settings = row[10]
    if isinstance(settings, str):
        settings = json.loads(settings)
    return {
        "id": row[0],
        "name": row[1],
        "provider": row[2],
        "model_id": row[3],
        "invoke_target": row[4],
        "dimensions": int(row[5]),
        "version": row[6],
        "status": row[7],
        "min_score": float(row[8]) if row[8] is not None else None,
        "split_threshold": float(row[9]) if row[9] is not None else None,
        "settings": settings if isinstance(settings, dict) else {},
        "cutover_locked": bool(row[11]),
    }


def get_guide_state(db_connection, chat_session_id: str) -> Optional[Dict[str, Any]]:
    """
    Guideline-mode state ({document_id, section_key, label}) from chat_sessions.metadata.

    The column is client-reachable storage, so the stored value is
    shape-checked and resolved against guideline_sections of a ready guide;
    anything that does not resolve gives None. The stored label is ignored:
    the canonical admin/auto label is returned instead.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                "SELECT metadata->'guide_state' FROM chat_sessions WHERE id = %s",
                (chat_session_id,)
            )
            row = cur.fetchone()
            key = guide_state_key(row[0]) if row else None
            if key is None:
                return None
            document_id, section_key = key
            cur.execute(
                """
                SELECT COALESCE(NULLIF(gs.label_override, ''), gs.auto_label, '')
                  FROM guideline_sections gs
                  JOIN guideline_documents d ON d.id = gs.document_id
                 WHERE d.status = 'ready'
                   AND gs.document_id = %s::uuid
                   AND gs.section_key = %s
                 LIMIT 1
                """,
                (document_id, section_key)
            )
            section = cur.fetchone()
            if not section:
                return None
            return {
                "document_id": document_id,
                "section_key": section_key,
                "label": (section[0] or "")[:MAX_GUIDE_LABEL_CHARS],
            }
    except Exception as e:
        logger.error(f"get_guide_state failed: {type(e).__name__}")
        try:
            db_connection.rollback()
        except Exception:
            pass
        return None


def save_guide_state(db_connection, chat_session_id: str, guide_state: Dict[str, Any]) -> None:
    """Persist guideline-mode state under its own chat_sessions.metadata key."""
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                UPDATE chat_sessions
                   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('guide_state', %s::jsonb)
                 WHERE id = %s
                """,
                (json.dumps(guide_state), chat_session_id)
            )
    except Exception as e:
        logger.error(f"save_guide_state failed: {type(e).__name__}")


def fetch_journey_catalog(db_connection) -> List[Tuple[Any, ...]]:
    """
    Active (non-archived) journeys and clusters with their active prompt
    versions, one row per cluster (journeys without clusters appear once with
    NULL cluster columns). Row shape matches journeys.catalog_from_rows.

    Returns [] on any error (for example before migration 024 has run). The
    transaction is rolled back so later queries on the shared connection work.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute("""
                SELECT
                    j.key, j.name, j.description, j.detection_signals, j.sort_order,
                    (SELECT v.content FROM journey_prompt_versions v
                      WHERE v.journey_id = j.id AND v.field = 'detective_questions' AND v.is_active
                      LIMIT 1),
                    (SELECT v.content FROM journey_prompt_versions v
                      WHERE v.journey_id = j.id AND v.field = 'guidance' AND v.is_active
                      LIMIT 1),
                    c.key, c.name, c.matches_when, c.sort_order,
                    (SELECT v.content FROM journey_prompt_versions v
                      WHERE v.cluster_id = c.id AND v.field = 'response_pattern' AND v.is_active
                      LIMIT 1)
                FROM journeys j
                LEFT JOIN journey_clusters c
                       ON c.journey_id = j.id AND c.is_archived = false
                WHERE j.is_archived = false
                ORDER BY j.sort_order, j.key, c.sort_order, c.key
            """)
            return list(cur.fetchall())
    except Exception as e:
        logger.error(f"fetch_journey_catalog failed: {type(e).__name__}")
        try:
            db_connection.rollback()
        except Exception:
            pass
        return []


def get_journey_state(db_connection, chat_session_id: str) -> Optional[str]:
    """
    Retrieve the journey_state string stored in chat_sessions.metadata.
    Returns None if no state has been saved yet.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                "SELECT metadata->>'journey_state' FROM chat_sessions WHERE id = %s",
                (chat_session_id,)
            )
            row = cur.fetchone()
            return row[0] if row and row[0] else None
    except Exception as e:
        logger.error(f"get_journey_state failed: {e}")
        return None


def save_journey_state(db_connection, chat_session_id: str, journey_state: str) -> None:
    """
    Persist the journey_state string into chat_sessions.metadata.
    Merges with any existing metadata using jsonb concatenation.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                UPDATE chat_sessions
                   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('journey_state', %s)
                 WHERE id = %s
                """,
                (journey_state, chat_session_id)
            )
    except Exception as e:
        logger.error(f"save_journey_state failed: {e}")


def get_session_context(db_connection, chat_session_id: str) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    Retrieve (journey_state, routing_state) from chat_sessions.metadata in one query.
    Either value is None if it has not been saved yet.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                "SELECT metadata->>'journey_state', metadata->'routing' FROM chat_sessions WHERE id = %s",
                (chat_session_id,)
            )
            row = cur.fetchone()
            if not row:
                return None, None
            journey_state = row[0] if row[0] else None
            routing = row[1] if isinstance(row[1], dict) else None
            return journey_state, routing
    except Exception as e:
        logger.error(f"get_session_context failed: {e}")
        return None, None


def get_prompt_mode_override(db_connection, chat_session_id: str) -> Optional[str]:
    """
    chat_sessions.prompt_mode_override (migration 035): the per-session prompt
    mode set only for verified evaluation-harness sessions. None for normal
    sessions and on any error (for example before migration 035 has run); the
    transaction is rolled back so later queries on the shared connection work.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                "SELECT prompt_mode_override FROM chat_sessions WHERE id = %s",
                (chat_session_id,)
            )
            row = cur.fetchone()
            return row[0] if row and row[0] in GUIDELINE_MODES else None
    except Exception as e:
        logger.error(f"get_prompt_mode_override failed: {type(e).__name__}")
        try:
            db_connection.rollback()
        except Exception:
            pass
        return None


def save_routing_state(db_connection, chat_session_id: str, routing_state: Dict[str, Any]) -> None:
    """
    Persist per-session routing state (enum-only fields) into chat_sessions.metadata.
    Merges with any existing metadata using jsonb concatenation.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                UPDATE chat_sessions
                   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('routing', %s::jsonb)
                 WHERE id = %s
                """,
                (json.dumps(routing_state), chat_session_id)
            )
    except Exception as e:
        logger.error(f"save_routing_state failed: {e}")
