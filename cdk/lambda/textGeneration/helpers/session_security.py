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

def validate_session_ownership(db_connection, session_id: str, user_id: str) -> bool:
    """
    Returns True when the session either doesn't exist yet (chat.py's
    ensure_session_exists will create it for this user_id on first save) or is
    already owned by this user_id. Returns False only when the session exists
    and belongs to a different user_id.
    """
    if not session_id or not user_id:
        logger.error("Session ID or user ID is empty or None")
        return False

    try:
        with db_connection.cursor() as cursor:
            cursor.execute("SELECT user_id FROM chat_sessions WHERE id = %s", (session_id,))
            result = cursor.fetchone()

            if result is None:
                # Session doesn't exist yet; it will be created for this user_id.
                return True

            is_owner = (result[0] == user_id)

            if not is_owner:
                logger.warning(f"User {user_id} does not own chat session: {session_id}")

            return is_owner

    except Exception as e:
        logger.error(f"DB Error: {e}")
        return False

        
