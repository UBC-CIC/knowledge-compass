import boto3
import logging
import re
from typing import Dict, Any, Optional, List, Tuple

from helpers.crud import (
    fetch_recent_messages, ensure_session_exists, insert_message, update_last_active_session,
    get_exchange_count, get_session_title, update_session_title, save_journey_state,
    get_session_context, save_routing_state, get_guide_state, save_guide_state
)
from helpers.guideline_retrieval import GUIDELINE_SOURCE_TYPE, retrieve_guideline_sections
from helpers.guideline_prompt import build_guideline_prompt, parse_guide_state
from helpers.logic import get_current_prompt
from helpers.routing import RoutingState, decide_phase, route_turn, touched_keys
from helpers.bedrock import format_context_for_prompt
from helpers.retrieval import retrieve_from_pgvector, to_public_source
from helpers.citations import parse_cited_indices, select_cited_sources, strip_internal_links
from helpers.intervention import assess_response
import helpers.config as config
from helpers.message_limits import check_limit, record_message_sent
from helpers.guardrail import invoke_guardrail, ACTION_ANONYMIZED, ACTION_BLOCKED

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

logger.info(f"boto3 version: {boto3.__version__}")

# Library resources offered alongside the guide sections in guideline mode.
GUIDELINE_RESOURCE_COUNT = 6

def _generate_session_title(
    query: str,
    answer_text: str,
    llm_region: str,
    haiku_model_arn: str = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
) -> Optional[str]:
    """
    Uses a fast, low-cost LLM call to generate a short, descriptive title for a
    chat session from its first exchange. Falls back to None on any error.
    """
    title_system_prompt = """
<instructions>
You write short titles for a chat sidebar, similar to how ChatGPT titles conversations.
Read the first exchange between a family and a support assistant about inclusive
education and school accommodation issues in Canada, then produce a concise,
specific title (3-6 words) that captures the family's situation or question,
for example "Sent Home Early Repeatedly" or "Requesting an EA Support Plan".
Do not use quotes, a trailing period, or generic titles like "Chat" or "New Conversation".
Output ONLY the title text.
</instructions>
"""
    user_message = f"""
<user_message>
{query}
</user_message>

<assistant_response>
{answer_text[:1000]}
</assistant_response>
"""
    try:
        bedrock_runtime = boto3.client("bedrock-runtime", region_name=llm_region)
        response = bedrock_runtime.converse(
            modelId=haiku_model_arn,
            messages=[{"role": "user", "content": [{"text": user_message}]}],
            system=[{"text": title_system_prompt}],
            inferenceConfig={
                "maxTokens": 20,
                "temperature": 0.0
            }
        )
        title = response["output"]["message"]["content"][0]["text"].strip()
        title = title.strip("\"' ").strip()
        return title[:80] if title else None
    except Exception as e:
        logger.warning(f"Session title generation failed: {e}")
        return None

def _prepare_conversation(
    query: str,
    region: str,
    llm_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    db_connection,
    save_user_message: bool = True
) -> Tuple[List[Dict[str, Any]], str, str, List[Dict[str, Any]], str, str, Dict[str, Any]]:
    """
    Handles validation, history fetching, user msg saving, routing, retrieval, and
    prompt construction.
    Returns: (bedrock_messages, static_system_prompt, dynamic_prompt, sources,
              phase_name, model_arn, routing_ctx)
      - phase_name is the public phase ("DETECTIVE" | "SUGGESTION")
      - routing_ctx carries the internal phase, route and prior routing state so
        the caller can persist the next routing state after generation.
    """
    # 1. Validation
    if not query or not query.strip():
        raise ValueError("Please provide a non-empty question.")

    # 2. Retrieve History
    raw_history = fetch_recent_messages(db_connection, chat_session_id)
    
    # 3. Save User Message
    try:
        if save_user_message:
            ensure_session_exists(db_connection, chat_session_id, user_id)
            insert_message(
                db_connection,
                chat_session_id,
                "user",
                query,
                sources=None,
                warning=None
            )
            update_last_active_session(db_connection, chat_session_id)
            db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"DB Error: {e}")
        raise

    # Guideline mode (migration 031): answer only from uploaded guides. Skips
    # the router, phases, journey catalog and corpus retrieval entirely.
    if config.PROMPT_MODE == "guideline":
        return _prepare_guideline_conversation(query, region, chat_session_id, db_connection, raw_history)

    # 4. Load session context. The user message is already saved, so the
    #    count equals the number of completed exchanges before this message.
    exchange_count = get_exchange_count(chat_session_id, db_connection)
    journey_state, stored_routing = get_session_context(db_connection, chat_session_id)
    routing_state = RoutingState.from_metadata(
        stored_routing, exchange_count, config.MIN_EXCHANGES_BEFORE_SUGGEST
    )

    # 5. Route the turn: retrieval query + routing signals in one Haiku call.
    #    None on failure -> raw query and the count-based phase rule.
    route = route_turn(
        raw_query=query,
        chat_history=raw_history,
        previous_state=journey_state,
        llm_region=llm_region,
        model_id=config.HAIKU_ARN,
        catalog=config.JOURNEY_CATALOG,
    )
    search_query = route.search_query if route else query

    phase = decide_phase(
        route=route,
        exchange_count=exchange_count,
        state=routing_state,
        routing_mode=config.ROUTING_MODE,
        floor=config.MIN_EXCHANGES_BEFORE_ANSWER,
        ceiling=config.MIN_EXCHANGES_BEFORE_SUGGEST,
    )
    logger.info(
        "Routing: mode=%s phase=%s exchange_count=%d router_ok=%s",
        config.ROUTING_MODE, phase, exchange_count, route is not None,
    )

    # 6. Build the phase prompt.
    static_system_prompt, num_retrieval_results, phase_name, phase_instructions, model_arn = get_current_prompt(
        phase=phase,
        exchange_count=exchange_count,
        journey_state=journey_state,
        route=route,
    )
    routing_ctx = {"phase": phase, "route": route, "state": routing_state}

    # 7. RAG Retrieval (using the routed query)
    sources = retrieve_from_pgvector(
        search_query,
        db_connection,
        region,
        num_results=num_retrieval_results,
    )

    # 8. Build Context
    context_block = format_context_for_prompt(sources)
    
    # 9. Construct Final System Prompt.
    # The phase block (from logic.get_current_prompt) already carries the
    # phase-appropriate <output_format> — including the <answer>/<cited_indices>
    # contract for the suggestion phase — so chat.py only appends retrieved context.
    dynamic_prompt = f"""{phase_instructions}

<retrieved_context>
{context_block}
</retrieved_context>
"""

    # 10. Build Messages
    bedrock_messages = []
    for msg in raw_history:
        role = "user" if msg["sender"] == "user" else "assistant"
        if msg["content"]:
            bedrock_messages.append({
                "role": role,
                "content": [{"text": msg["content"]}]
            })
            
    bedrock_messages.append({
        "role": "user",
        "content": [{"text": query}]
    })

    return bedrock_messages, static_system_prompt, dynamic_prompt, sources, phase_name, model_arn, routing_ctx

def _prepare_guideline_conversation(
    query: str,
    region: str,
    chat_session_id: str,
    db_connection,
    raw_history: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], str, str, List[Dict[str, Any]], str, str, Dict[str, Any]]:
    """
    Guideline-mode counterpart of the routing/phase/retrieval steps of
    _prepare_conversation. Returns the same tuple; the public phase is always
    "SUGGESTION" so the <answer>/<cited_indices> streaming contract applies.
    """
    previous_section = get_guide_state(db_connection, chat_session_id)
    sections = retrieve_guideline_sections(
        query,
        db_connection,
        region,
        previous_section=previous_section,
    )
    # Supporting library resources (videos, documents, web pages, CSV rows)
    # from the regular corpus. Guides are hidden from this search, so there
    # is no overlap. Searched with the situation name when one is known, so
    # follow-ups still find resources for the same situation.
    resource_query = query
    if previous_section and previous_section.get("label"):
        resource_query = f"{query}\n\n{previous_section['label']}"
    resources = retrieve_from_pgvector(
        resource_query,
        db_connection,
        region,
        num_results=GUIDELINE_RESOURCE_COUNT,
    )
    static_system_prompt, dynamic_prompt, model_arn = build_guideline_prompt(
        sections, previous_section, resources
    )
    logger.info(
        "Routing: mode=guideline sections=%d resources=%d previous_section=%s",
        len(sections), len(resources), bool(previous_section),
    )

    bedrock_messages = []
    for msg in raw_history:
        role = "user" if msg["sender"] == "user" else "assistant"
        if msg["content"]:
            bedrock_messages.append({"role": role, "content": [{"text": msg["content"]}]})
    bedrock_messages.append({"role": "user", "content": [{"text": query}]})

    routing_ctx = {"mode": "guideline", "previous_section": previous_section}
    # One combined list: guide sections [1..n], then resources [n+1..], the
    # same numbering the prompt uses for <cited_indices>.
    sources = list(sections) + list(resources)
    return bedrock_messages, static_system_prompt, dynamic_prompt, sources, "SUGGESTION", model_arn, routing_ctx


def _public_guideline_source(source: Dict[str, Any]) -> Dict[str, Any]:
    """Guide citations show the situation name only: no link, no content preview."""
    public = to_public_source(source)
    public["title"] = f"Family guide: {source.get('title') or 'Guidance'}"
    public["content"] = ""
    public["url"] = ""
    public["uri"] = ""
    public.pop("metadata", None)
    return public


def _save_ai_response(
    db_connection,
    chat_session_id: str,
    answer_text: str,
    sources: List[Dict[str, Any]],
    warning_text: Optional[str] = None,
):
    try:
        # `sources` is already the trimmed public projection (to_public_source).
        insert_message(
            db_connection,
            chat_session_id,
            "AI",
            answer_text,
            list(sources),
            warning_text
        )
        update_last_active_session(db_connection, chat_session_id)
        db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"Failed to save AI response: {e}")

def get_response(
    query: str,
    region: str,
    llm_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    db_connection,
    save_user_message: bool = True,
    stream_callback=None,
    is_intro_message: bool = False,
) -> Dict[str, Any]:
    
    usage_info = {}
    is_under_limit = True

    try:
        if user_id:
            is_under_limit, usage_info = check_limit(user_id, db_connection)
            if not is_under_limit:
                return {
                    "response": "Daily message limit exceeded. Please try again tomorrow.",
                    "sources_used": [],
                    "sessionId": chat_session_id,
                    "is_first_message": False,
                    "message_limit_exceeded": True,
                    "message_usage": usage_info,
                    "warning": None,
                    "intervention": None,
                    "phase": None,
                }

        if not is_intro_message:
            try:
                guardrail_result = invoke_guardrail(query, config.REGION)
            except Exception as e:
                logger.error(f"Guardrail invocation failed: {e}")
                return {
                    "response": "An error occurred processing your request.",
                    "sources_used": [],
                    "warning": None,
                    "intervention": None,
                    "phase": None,
                }

            if guardrail_result['action'] == ACTION_BLOCKED:
                denial_text = guardrail_result['text']
                try:
                    ensure_session_exists(db_connection, chat_session_id, user_id)
                    insert_message(db_connection, chat_session_id, 'user', query, sources=None, warning=None)
                    update_last_active_session(db_connection, chat_session_id)
                    db_connection.commit()
                except Exception as db_err:
                    db_connection.rollback()
                    logger.error(f"DB error saving user message on intervention: {db_err}")
                _save_ai_response(db_connection, chat_session_id, denial_text, sources=[], warning_text=None)
                if stream_callback:
                    stream_callback(denial_text)
                return {
                    "response": denial_text,
                    "sources_used": [],
                    "sessionId": chat_session_id,
                    "is_first_message": False,
                    "message_usage": {},
                    "warning": None,
                    "intervention": None,
                    "phase": None,
                }

            if guardrail_result['action'] == ACTION_ANONYMIZED:
                query = guardrail_result['text']

        bedrock_messages, static_system_prompt, dynamic_prompt, sources, phase_name, model_arn, routing_ctx = _prepare_conversation(
            query,
            region,
            llm_region,
            chat_session_id,
            user_id,
            db_connection,
            save_user_message=save_user_message
        )

        if user_id and save_user_message:
            usage_info = record_message_sent(user_id, db_connection)

    except ValueError as e:
        return {
            "response": str(e),
            "sources_used": [],
            "warning": None,
            "intervention": None,
            "phase": None,
        }
    except Exception as e:
        logger.error(f"Prepare conversation failed: {e}")
        return {
            "response": "An error occurred.",
            "sources_used": [],
            "warning": None,
            "intervention": None,
            "phase": None,
        }

    # Structure the system array with the cache point
    request_payload = {
            "modelId": model_arn,
            "messages": bedrock_messages,
            "system": [
                {"text": static_system_prompt},
                {"cachePoint": 
                    {
                    "type":"default"
                    }
                },
                {"text": dynamic_prompt}
            ],
            "inferenceConfig": {
                "maxTokens": config.MAX_TOKENS,
                "temperature": config.TEMPERATURE
            }
        }

    if model_arn == config.SONNET_ARN:
        request_payload["additionalModelRequestFields"] = {
            "thinking" : {"type": "disabled"},
        }

    bedrock_runtime = boto3.client("bedrock-runtime", region_name=llm_region)
    
    full_response_text = ""
    yielded_text = ""
    answer_started = False
    answer_text = ""
    cited_indices = []
    expect_answer_tags = phase_name == "SUGGESTION"
    is_guideline = routing_ctx.get("mode") == "guideline"
    # Hidden metadata tags that must never reach the stream. Guideline mode
    # adds <guide_state>; standard mode keeps its original tag lists.
    stream_stop_tags = ["</answer>", "<cited", "<detective_state"]
    stream_hold_tags = ["</answer>", "<cited_indices>", "</cited_indices>", "<cited", "<detective_state>", "</detective_state>"]
    if is_guideline:
        stream_stop_tags.append("<guide_state")
        stream_hold_tags.extend(["<guide_state>", "</guide_state>"])

    try:
        response = bedrock_runtime.converse_stream(**request_payload)
        for event in response.get("stream", []):
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"]["delta"]
                if "text" in delta:
                    chunk = delta["text"]
                    full_response_text += chunk

                    # Detective replies are plain text followed by a hidden
                    # <detective_state> tag. Suggestion replies wrap the visible
                    # answer in <answer> tags. In both cases, stop streaming
                    # before hidden metadata tags.
                    if expect_answer_tags:
                        if "<answer>" in full_response_text:
                            answer_started = True
                            target_text = full_response_text.split("<answer>", 1)[1]
                        elif not answer_started and len(full_response_text) > 300 and "<" not in full_response_text:
                            target_text = full_response_text
                        else:
                            continue
                    else:
                        target_text = full_response_text
                        
                    # 2. Stop extracting if we hit a closing tag or hidden metadata tag
                    stop_found = False
                    for stop_tag in stream_stop_tags:
                        stop_idx = target_text.find(stop_tag)
                        if stop_idx != -1:
                            target_text = target_text[:stop_idx]
                            stop_found = True
                            
                    # 3. Prevent partial tags at the end of the chunk from leaking
                    if not stop_found:
                        held_back = 0
                        for stop_tag in stream_hold_tags:
                            for i in range(1, len(stop_tag)):
                                if target_text.endswith(stop_tag[:i]):
                                    held_back = max(held_back, i)
                        
                        safe_text = target_text[:-held_back] if held_back > 0 else target_text
                    else:
                        safe_text = target_text
                        
                    # 4. Stream only the newly added text
                    if len(safe_text) > len(yielded_text):
                        new_text = safe_text[len(yielded_text):]
                        yielded_text += new_text
                        if stream_callback and new_text:
                            stream_callback(new_text)

        # Parse final answer text properly
        final_answer_match = re.search(r'<answer>(.*?)</answer>', full_response_text, re.DOTALL)
        if final_answer_match:
            answer_text = final_answer_match.group(1).strip()
        else:
            # Detective phase: strip any trailing <detective_state> tag from saved text
            answer_text = re.split(r'<(?:cited_indices|detective_state|guide_state)', full_response_text)[0].strip()
            
        # Parse cited_indices tolerantly: one malformed token must not drop
        # every citation.
        parsed_indices = parse_cited_indices(full_response_text)
        if parsed_indices is not None:
            cited_indices = parsed_indices
        elif sources and "<answer>" in full_response_text:
            # Guidance reply without the citation block: sources can't be shown.
            logger.warning(
                "Guidance reply had no <cited_indices> block (phase=%s, retrieved=%d)",
                phase_name,
                len(sources),
            )

    except Exception as e:
        logger.error(f"Generation Failed: {e}")
        answer_text = "I encountered an error generating the response."
        cited_indices = []

    # Full cited sources feed the grounding verifier; only the trimmed public
    # projection is streamed to the client and persisted with the message.
    used_sources = select_cited_sources(sources, cited_indices)
    public_sources = [
        _public_guideline_source(source)
        if source.get("source_type") == GUIDELINE_SOURCE_TYPE
        else to_public_source(source)
        for source in used_sources
    ]

    warning_text = None
    intervention_result = None

    # Guideline mode: a clarifying question cites no section, so there is
    # nothing to verify; answers are checked against the full sections.
    run_grounding_check = phase_name == "SUGGESTION" and (not is_guideline or bool(used_sources))

    if run_grounding_check and answer_text and not answer_text.startswith("I encountered an error"):
        try:
            intervention_result = assess_response(
                query=query,
                answer_text=answer_text,
                sources=used_sources,
                llm_region=llm_region
            )
            warning_text = intervention_result.get("warning_text")
        except Exception as e:
            logger.error(f"Intervention Failed: {e}")
            warning_text = None
            intervention_result = None
            
    # Older history turns may contain internal links the model could echo.
    final_answer_text = strip_internal_links(answer_text)

    _save_ai_response(
        db_connection,
        chat_session_id,
        final_answer_text,
        public_sources,
        warning_text
    )

    # Guideline mode keeps its own state (the chosen section) under
    # metadata.guide_state and never touches journey/routing state.
    if is_guideline:
        guide_state = parse_guide_state(full_response_text, sources)
        logger.info(
            "Guideline turn: sources=%d cited=%d selected_section=%s",
            len(sources), len(used_sources), guide_state["section_key"] if guide_state else None,
        )
        if guide_state and answer_text and not answer_text.startswith("I encountered an error"):
            try:
                save_guide_state(db_connection, chat_session_id, guide_state)
                db_connection.commit()
            except Exception as e:
                db_connection.rollback()
                logger.warning(f"Failed to save guide state: {type(e).__name__}")

    # Extract and persist journey state for multi-turn context.
    # Suggestion phase: <journey_state> after <cited_indices>.
    # Detective phase: <detective_state> after the visible response.
    # Both are never streamed to the user.
    if full_response_text and not is_guideline:
        try:
            state_text = None
            if phase_name == "SUGGESTION":
                state_match = re.search(
                    r'<journey_state>(.*?)</journey_state>',
                    full_response_text,
                    re.DOTALL
                )
                if state_match:
                    state_text = state_match.group(1).strip()
            elif phase_name == "DETECTIVE":
                state_match = re.search(
                    r'<detective_state>(.*?)</detective_state>',
                    full_response_text,
                    re.DOTALL
                )
                if state_match:
                    state_text = state_match.group(1).strip()

            if state_text:
                save_journey_state(db_connection, chat_session_id, state_text)
                db_connection.commit()
        except Exception as e:
            db_connection.rollback()
            logger.warning(f"Failed to save journey state: {e}")

    # Advance routing state only after a successful reply, so a failed
    # generation does not count as a question asked or guidance given.
    if not is_guideline and answer_text and not answer_text.startswith("I encountered an error"):
        try:
            # Journey/situation keys only (no text) for feedback analytics.
            journeys_touched, clusters_touched = touched_keys(
                routing_ctx["route"], routing_ctx["phase"], config.JOURNEY_CATALOG
            )
            next_state = routing_ctx["state"].advance(
                routing_ctx["phase"], journeys_touched, clusters_touched
            )
            save_routing_state(
                db_connection,
                chat_session_id,
                next_state.to_metadata(routing_ctx["route"]),
            )
            db_connection.commit()
        except Exception as e:
            db_connection.rollback()
            logger.warning(f"Failed to save routing state: {e}")

    generated_title = None
    if final_answer_text and not final_answer_text.startswith("I encountered an error"):
        try:
            current_title = get_session_title(db_connection, chat_session_id)
            is_untitled = current_title is None or current_title.strip() in ("", "New Session")
            if is_untitled and get_exchange_count(chat_session_id, db_connection) == 1:
                generated_title = _generate_session_title(query, final_answer_text, llm_region)
                if generated_title:
                    update_session_title(db_connection, chat_session_id, generated_title)
                    db_connection.commit()
        except Exception as e:
            db_connection.rollback()
            logger.warning(f"Failed to auto-title session: {e}")

    return {
        "response": final_answer_text,
        "raw_response": answer_text,
        "sources_used": public_sources,
        "sessionId": chat_session_id,
        "is_first_message": False,
        "message_usage": usage_info,
        "warning": warning_text,
        "intervention": intervention_result,
        "phase": phase_name,
        "session_name": generated_title,
    }