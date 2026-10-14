
import boto3.exceptions
import json
from helpers.cors import get_cors_headers
import logging
import os
import boto3
from helpers.chat import get_response
from helpers.crud import fetch_service_status
from helpers.embedding_space import EmbeddingSpaceError
from helpers.db_connection import get_db_connection
import helpers.config as config
from helpers.session_security import resolve_caller_user_id, validate_session_ownership, sanitize_session_id
from helpers.message_limits import reserve_daily_characters, GLOBAL_LIMIT_REASON

logger = logging.getLogger()
logger.setLevel(logging.INFO)

GENERIC_ERROR_MESSAGE = "Sorry, something went wrong while preparing a response. Please try again."
READ_ONLY_DEFAULT_MESSAGE = "Chat is temporarily read-only. Please try again later."
DAILY_LIMIT_ERROR = "DAILY_CHARACTER_LIMIT_EXCEEDED"
DAILY_LIMIT_MESSAGE = "You've reached today's message limit. Please come back tomorrow."
# Used when some allowance is left but this message doesn't fit in it.
DAILY_LIMIT_PARTIAL_MESSAGE = (
    "This message is longer than the {remaining:,} characters you have left today. "
    "Please try a shorter message."
)
# Service-wide daily message budget (system_settings.max_messages_per_day_global).
GLOBAL_DAILY_LIMIT_ERROR = "GLOBAL_DAILY_LIMIT_EXCEEDED"
GLOBAL_DAILY_LIMIT_MESSAGE = "The assistant is very busy today. Please try again tomorrow."


def _daily_limit_message(char_usage):
    remaining = (char_usage or {}).get('remaining') or 0
    if remaining > 0:
        return DAILY_LIMIT_PARTIAL_MESSAGE.format(remaining=remaining)
    return DAILY_LIMIT_MESSAGE


def _get_ws_client(event):
    """Return (apigw_management_client, connection_id) for WebSocket-invoked
    requests, or (None, None) for REST requests / misconfigured contexts."""
    request_context = event.get('requestContext') or {}
    connection_id = request_context.get('connectionId')
    domain_name = request_context.get('domainName')
    stage = request_context.get('stage')
    if not (connection_id and domain_name and stage):
        return None, None
    try:
        client = boto3.client(
            'apigatewaymanagementapi',
            endpoint_url=f"https://{domain_name}/{stage}",
        )
        return client, connection_id
    except Exception as e:
        logger.error(f"Failed to initialize WebSocket client: {e}")
        return None, None


def _post_ws(apigw_management, connection_id, payload):
    """Best-effort post to the WebSocket connection. Never raises."""
    if not (apigw_management and connection_id):
        return False
    try:
        apigw_management.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps(payload),
        )
        return True
    except Exception as e:
        logger.error(f"Failed to post to WebSocket connection: {e}")
        return False


def handler(event, context=None):
    # Log event but exclude body to prevent sensitive data exposure (user_id, chat_session_id)
    safe_event = {k: v for k, v in event.items() if k != 'body'}
    logger.info("Event: %s (body omitted)", json.dumps(safe_event, default=str))

    # Resolved up front so every failure path can send a terminal "error"
    # event; otherwise the client waits on its typing indicator forever.
    apigw_management, connection_id = _get_ws_client(event)

    def fail(status_code, error, message=GENERIC_ERROR_MESSAGE, extra=None):
        _post_ws(apigw_management, connection_id, {
            'type': 'error',
            'error': error,
            'message': message,
            **(extra or {}),
        })
        return {
            'statusCode': status_code,
            'headers': {'Content-Type': 'application/json', **get_cors_headers(event)},
            'body': json.dumps({'error': error, **(extra or {})}),
        }

    body = {}
    if 'body' in event and event['body']:
        try:
            if isinstance(event['body'], str):
                body = json.loads(event['body'])
            else:
                body = event['body']
        except Exception as e:
            logger.error(f"Failed to parse body: {e}")
            return fail(400, 'Invalid JSON body')

    if not isinstance(body, dict):
        return fail(400, 'Invalid JSON body')

    query = body.get('query')

    chat_session_id = body.get('chat_session_id')

    # Fallback to path parameters
    if not chat_session_id and 'pathParameters' in event and event['pathParameters']:
        chat_session_id = event['pathParameters'].get('chat_session_id') or event['pathParameters'].get('id')

    # The acting user comes only from the verified token: API Gateway's user
    # authorizer on the REST route, or websocket/default.js on the stream path.
    # A body user_id (older clients) must match it.
    user_id, caller_error = resolve_caller_user_id(event, body.get('user_id'))
    if caller_error:
        status_code, error = caller_error
        return fail(status_code, error, "Your session has expired. Please refresh the page and try again.")

    # Presence/type check must come before the length check (len(None) raises).
    if not isinstance(query, str) or not query.strip() or not chat_session_id:
        return fail(400, 'Missing query or chat_session_id')

    # Perform Query Length Validation
    if len(query) > config.MAX_CHARACTERS_PER_USER_MESSAGE:
        return fail(
            400,
            f'Query exceeds maximum length of {config.MAX_CHARACTERS_PER_USER_MESSAGE} characters',
            f'Your message is too long. Please keep it under {config.MAX_CHARACTERS_PER_USER_MESSAGE} characters.',
        )

    # Sanitize session ID before querying DB
    try:
        chat_session_id = sanitize_session_id(chat_session_id)
    except ValueError as e:
        logger.error(f"Invalid session ID: {e}")
        return fail(400, 'Invalid session ID')

    conn = None
    try:
        conn = get_db_connection()

        # Validate the session ownership before doing anything with the session
        # (user_id is required above, so this always runs).
        if not validate_session_ownership(conn, chat_session_id, user_id):
            return fail(
                403,
                'Unauthorized access to chat session',
                "This chat session couldn't be found. Please start a new chat.",
            )

        # Read-only fallback (admin "Assistant settings" > service status, migration 034).
        # Refuses a new turn with the standard `error` event, before `start` is sent and
        # before any retrieval or model call. A banner does not block. The status read
        # falls back to normal on error, so it can never take chat down by itself.
        service = fetch_service_status(conn)
        if service['status'] == 'read_only':
            return fail(
                503,
                'SERVICE_READ_ONLY',
                service['message'] or READ_ONLY_DEFAULT_MESSAGE,
            )

        # Load dynamic configuration from DB
        config.load_config(conn)

        # Daily character allowance (per user, per UTC day, across all of the
        # user's sessions). Counted on receipt, before the guardrail, retrieval
        # and any Bedrock call; an over-limit message is rejected whole. A DB
        # error here raises into the generic 500 below (fail closed). The Lambda
        # request id stays the same across async retries, so a retried
        # invocation is not counted twice. The same transaction also counts the
        # message against the service-wide daily message budget.
        allowed, char_usage = reserve_daily_characters(
            user_id, len(query), conn, config.MAX_CHARACTERS_PER_DAY,
            request_id=getattr(context, 'aws_request_id', None),
            global_limit=config.MAX_MESSAGES_PER_DAY_GLOBAL,
        )
        if not allowed and char_usage.get('reason') == GLOBAL_LIMIT_REASON:
            logger.warning("Global daily message budget reached")
            return fail(429, GLOBAL_DAILY_LIMIT_ERROR, GLOBAL_DAILY_LIMIT_MESSAGE,
                        extra={'message': GLOBAL_DAILY_LIMIT_MESSAGE})
        if not allowed:
            logger.info("Daily character limit reached")
            limit_message = _daily_limit_message(char_usage)
            return fail(429, DAILY_LIMIT_ERROR, limit_message,
                        extra={'message': limit_message, 'character_usage': char_usage})

        # Send start message
        _post_ws(apigw_management, connection_id, {'type': 'start'})

        def stream_chunk(chunk_text):
            _post_ws(apigw_management, connection_id, {'type': 'chunk', 'content': chunk_text})

        response_data = get_response(
            query=query,
            region=config.REGION,
            llm_region=config.LLM_REGION,
            chat_session_id=chat_session_id,
            user_id=user_id,
            db_connection=conn,
            stream_callback=stream_chunk,
        )
        
        # Format response to match API contract
        # Map sources_used -> sources
        response_body = {
            "response": response_data.get("response", ""),
            "sources": response_data.get("sources_used", []),
            "warning": response_data.get("warning"),
            "chat_session_id": response_data.get("sessionId"),
            "token_usage": response_data.get("token_usage", {}),
            "phase": response_data.get("phase"),
            "session_name": response_data.get("session_name"),
        }
        
        status_code = 200
        if response_data.get("token_limit_exceeded"):
            status_code = 429
            response_body["error"] = "TOKEN_LIMIT_EXCEEDED"
            response_body["message"] = response_body["response"]
            
        # Send WebSocket terminal message
        if status_code == 429:
            # Send specific error over WS for token limits
            if _post_ws(apigw_management, connection_id, {
                'type': 'error',
                'error': 'TOKEN_LIMIT_EXCEEDED',
                'message': response_body['message'],
                'token_usage': response_body.get('token_usage', {}),
            }):
                logger.info(f"Sent WebSocket token limit error to {connection_id}")
        else:
            # Send complete message with sources
            if _post_ws(apigw_management, connection_id, {
                'type': 'complete',
                'response': response_body['response'],
                'sources': response_body['sources'],
                'warning': response_body.get('warning'),
                'chat_session_id': response_body['chat_session_id'],
                'token_usage': response_body.get('token_usage', {}),
                'phase': response_body.get('phase'),
                'session_name': response_body.get('session_name'),
            }):
                logger.info(f"Sent WebSocket response (complete) to {connection_id}")

        return {
            'statusCode': status_code,
            'headers': { 'Content-Type': 'application/json', **get_cors_headers(event) },
            'body': json.dumps(response_body)
        }

    except EmbeddingSpaceError as e:
        # The embedding space is missing or inconsistent (already logged with its
        # code and emitted as a metric). The client gets the standard `error`
        # event with no internal detail.
        logger.error("Embedding space unavailable: code=%s", e.code)
        return fail(
            503,
            'EMBEDDING_SPACE_UNAVAILABLE',
            "The assistant is temporarily unavailable. Please try again shortly.",
        )
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        return fail(500, 'Internal server error')
