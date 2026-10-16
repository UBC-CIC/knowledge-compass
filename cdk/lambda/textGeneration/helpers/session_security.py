import uuid
import logging 

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def sanitize_session_id(session_id: str) -> str:
    # Check 1: Reject a session id that's empty/None 

    if not session_id: 
        raise ValueError("Session ID is empty or None")

    # Check 2: Remove any whitespace 
    session_id = session_id.strip()

    # Check 3: Rejection anything that's not a valid uuid 
    try: 
        uuid.UUID(session_id)
    except ValueError:
        raise ValueError(f"Invalid session ID: {session_id}")
    
    return session_id

def _is_uuid(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def resolve_caller_user_id(event, claimed_user_id=None):
    """
    The acting user's id from requestContext.authorizer.userId, which only the
    REST user authorizer and websocket/default.js set from a verified access
    token. Returns (user_id, None) or (None, (status_code, error)).
    A client-supplied `claimed_user_id` must match it when present.
    """
    authorizer = (event.get('requestContext') or {}).get('authorizer') or {}
    user_id = authorizer.get('userId')
    if not _is_uuid(user_id):
        return None, (401, 'A user session token is required')
    if claimed_user_id not in (None, '') and claimed_user_id != user_id:
        logger.warning("Rejected request whose user_id does not match the session token")
        return None, (403, 'user_id does not match the session token')
    return user_id, None


def validate_session_ownership(db_connection, session_id: str, user_id: str) -> bool:
    """
    Returns True only when the session exists and is owned by user_id. A
    missing or foreign session returns False (the same 403 for both). Sessions
    are created only by POST /chat_sessions, never by the generation path.
    Because chat_sessions.user_id references users(id), True also means the
    caller's users row exists. Logs carry no user or session ids.
    """
    if not session_id or not user_id:
        logger.error("Session ID or user ID is empty or None")
        return False

    try:
        with db_connection.cursor() as cursor:
            cursor.execute("SELECT user_id FROM chat_sessions WHERE id = %s", (session_id,))
            result = cursor.fetchone()

            if result is None:
                logger.warning("Chat session not found for ownership check")
                return False

            # user_id may come back as uuid.UUID depending on the driver.
            is_owner = (str(result[0]) == str(user_id))

            if not is_owner:
                logger.warning("Rejected chat session not owned by the caller")

            return is_owner

    except Exception as e:
        logger.error("Session ownership check failed: %s", type(e).__name__)
        return False

        
