
import boto3.exceptions
import json
from helpers.cors import get_cors_headers
import logging
import os
import boto3
from helpers.chat import get_response
from helpers.embedding_space import EmbeddingSpaceError
from helpers.db_connection import get_db_connection
import helpers.config as config
from helpers.session_security import validate_session_ownership, sanitize_session_id

logger = logging.getLogger()
logger.setLevel(logging.INFO)

GENERIC_ERROR_MESSAGE = "Sorry, something went wrong while preparing a response. Please try again."


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

    def fail(status_code, error, message=GENERIC_ERROR_MESSAGE):
        _post_ws(apigw_management, connection_id, {
            'type': 'error',
            'error': error,
            'message': message,
        })
        return {
            'statusCode': status_code,
            'headers': {'Content-Type': 'application/json', **get_cors_headers(event)},
            'body': json.dumps({'error': error}),
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
    is_intro_message = body.get('is_intro_message', False)

    chat_session_id = body.get('chat_session_id')

    # Fallback to path parameters
    if not chat_session_id and 'pathParameters' in event and event['pathParameters']:
        chat_session_id = event['pathParameters'].get('chat_session_id') or event['pathParameters'].get('id')

    user_id = body.get('user_id')

    # Presence/type check must come before the length check (len(None) raises).
    if not isinstance(query, str) or not query.strip() or not chat_session_id or not user_id:
        return fail(400, 'Missing query, chat_session_id, or user_id')

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

        # Load dynamic configuration from DB
        config.load_config(conn)

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
            is_intro_message=is_intro_message
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
