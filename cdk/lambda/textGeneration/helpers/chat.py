import boto3
import logging
import re
from typing import Dict, Any, Optional, List, Tuple

from helpers.crud import (
    fetch_recent_messages, insert_message, update_last_active_session,
    get_exchange_count, get_session_title, update_session_title, save_journey_state,
    get_session_context, save_routing_state, get_guide_state, save_guide_state,
)
from helpers.guideline_retrieval import GUIDELINE_SOURCE_TYPE, retrieve_guideline_sections
from helpers.guideline_prompt import build_guideline_prompt, format_sections, parse_guide_state
from helpers.journey_guides import document_ids_for_turn, fetch_journey_coverage, outlines_for
from helpers.journeys import apply_document_coverage
from helpers.logic import get_current_prompt
from helpers.routing import DETECTIVE, RoutingState, decide_phase, route_turn, touched_keys
from helpers.bedrock import format_context_for_prompt
from helpers.prompt_data import data_block_note
from helpers.embedding_space import EmbeddingSpaceError
from helpers.retrieval import (
    DEFAULT_MIN_SCORE, effective_min_score, public_http_url, retrieve_from_pgvector, to_public_source,
)
from helpers.citations import (
    merge_cited_and_linked,
    parse_cited_indices,
    parse_cited_refs,
    select_cited_sources,
    select_linked_sources,
    stream_settled_length,
    strip_internal_links,
    strip_unverified_links,
)
from helpers.intervention import assess_response
from helpers.bedrock_clients import bedrock_runtime
import helpers.config as config
from helpers.message_limits import reserve_daily_message
from helpers.guardrail import (
    invoke_guardrail, invoke_output_guardrail, ACTION_ANONYMIZED, ACTION_BLOCKED, BLOCKED_INPUT_PLACEHOLDER,
    OutputStreamScreener,
)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

logger.info(f"boto3 version: {boto3.__version__}")

# Library resources offered alongside the guide sections in guideline mode.
GUIDELINE_RESOURCE_COUNT = 6
# Library resources shown under "More resources" when a guidance answer cited
# no resource itself (matches the prompt's "no more than two").
GUIDELINE_FALLBACK_RESOURCE_COUNT = 2

# Appended on guidance turns that retrieved a journey's documents. Guide
# sections are labeled G1, G2, ...; library sources keep their own numbers
# from 1, so a plain number in <cited_indices> always means a library source.
GUIDE_CITE_NOTE = """
The <guide_sections> block is labeled [G1], [G2], ... and the library sources in
<retrieved_context> are numbered separately as [1], [2], .... When you give
guidance from a section, include that section's label (for example G1) in
<cited_indices>, plus the number of every library source you linked, for
example <cited_indices>[G1, 2]</cited_indices>. Also output
<guide_state>section: Gn</guide_state> with that section's label, or
<guide_state>section: 0</guide_state> if you did not use one.
""".strip()

# Per-answer character cap (finding A-06). The admin setting
# max_characters_per_ai_message sets it; this is used when the loaded value is
# missing or not a positive integer. Matches config.MAX_CHARACTERS_PER_AI_MESSAGE.
ANSWER_CHAR_CAP_FALLBACK = 5000
# Ends an answer that was cut to the cap. Counted within the cap.
ANSWER_TRUNCATION_MARKER = "…"

# Hidden metadata tags the model writes after the visible answer. They are
# parsed server-side and must never reach the family, even when the model puts
# them inside <answer> or leaves out </answer>.
HIDDEN_TAG_NAMES = ("journey_state", "cited_indices", "detective_state", "guide_state")
_HIDDEN_NAMES_RE = "|".join(HIDDEN_TAG_NAMES)
_HIDDEN_BLOCK_RE = re.compile(rf"<({_HIDDEN_NAMES_RE})>.*?</\1>", re.DOTALL | re.IGNORECASE)
_HIDDEN_OPEN_RE = re.compile(rf"<(?:{_HIDDEN_NAMES_RE})\b", re.IGNORECASE)
_HIDDEN_STRAY_RE = re.compile(rf"</(?:{_HIDDEN_NAMES_RE})>|</?answer>", re.IGNORECASE)


def strip_hidden_tags(text: str) -> str:
    """
    Remove hidden metadata blocks from visible text. Closed blocks are removed
    wherever they appear; an unclosed opening tag drops everything after it;
    stray closing tags and <answer> tags are removed.
    """
    if not text:
        return text
    text = _HIDDEN_BLOCK_RE.sub("", text)
    open_match = _HIDDEN_OPEN_RE.search(text)
    if open_match:
        text = text[:open_match.start()]
    return _HIDDEN_STRAY_RE.sub("", text).strip()


def _sanitize_history(raw_history: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Strip hidden tags from earlier AI messages before they are replayed to the
    router and the model, so a reply that leaked a tag is not copied forward.
    User messages are left as written.
    """
    cleaned = []
    for msg in raw_history or []:
        if msg.get("sender") != "user" and msg.get("content"):
            msg = {**msg, "content": strip_hidden_tags(msg["content"])}
        cleaned.append(msg)
    return cleaned


# Sent when generation or the output guardrail fails. Failure is tracked by the
# generation_failed flag, never by matching this text: the model can be asked
# to start its answer with it (finding f-db9c8d85).
GENERATION_ERROR_TEXT = "I encountered an error generating the response."


def answer_char_cap() -> int:
    """The per-answer character cap from the loaded system settings."""
    try:
        cap = int(config.MAX_CHARACTERS_PER_AI_MESSAGE)
    except (TypeError, ValueError):
        return ANSWER_CHAR_CAP_FALLBACK
    return cap if cap > 0 else ANSWER_CHAR_CAP_FALLBACK


# maxTokens for the answer call, derived from the character cap. Text past the
# cap is never shown, so tokens beyond it are paid for and discarded. English
# runs about 4 characters per token; 3 is used so a dense answer still fits.
# The headroom covers the hidden tags written after the answer
# (<cited_indices>, <journey_state>/<detective_state>, <guide_state>).
CHARS_PER_TOKEN_ESTIMATE = 3
HIDDEN_TAG_TOKEN_HEADROOM = 500


def generation_max_tokens(char_cap: int) -> int:
    """maxTokens for the answer: enough for char_cap plus the hidden tags, at most config.MAX_TOKENS."""
    needed = -(-char_cap // CHARS_PER_TOKEN_ESTIMATE) + HIDDEN_TAG_TOKEN_HEADROOM
    return min(config.MAX_TOKENS, needed)


def _log_generation_usage(usage: Dict[str, Any], stop_reason: Optional[str], max_tokens: int) -> None:
    """Token counts and stop reason only, never message text."""
    logger.info(
        "Generation usage: input=%s output=%s cache_read=%s cache_write=%s stop_reason=%s max_tokens=%d",
        usage.get("inputTokens"),
        usage.get("outputTokens"),
        usage.get("cacheReadInputTokens", 0),
        usage.get("cacheWriteInputTokens", 0),
        stop_reason,
        max_tokens,
    )
    if stop_reason == "max_tokens":
        logger.warning("Generation stopped at maxTokens=%d; hidden tags may be missing", max_tokens)


def cap_answer_length(text: str, cap: int) -> str:
    """
    Cut text to at most cap characters. The cut falls on the last whitespace
    in the second half of the allowed length, so a word or link is not split
    when that is avoidable, and ends with ANSWER_TRUNCATION_MARKER.
    """
    if len(text) <= cap:
        return text
    keep = max(cap - len(ANSWER_TRUNCATION_MARKER), 0)
    cut = text[:keep]
    boundary = max(cut.rfind(" "), cut.rfind("\n"))
    if boundary > keep // 2:
        cut = cut[:boundary]
    return cut.rstrip() + ANSWER_TRUNCATION_MARKER


def _generate_session_title(
    query: str,
    answer_text: str,
    llm_region: str,
    haiku_model_arn: Optional[str] = None,
) -> Optional[str]:
    """
    Uses a fast, low-cost LLM call to generate a short, descriptive title for a
    chat session from its first exchange. Falls back to None on any error.
    The model defaults to config.HAIKU_ARN (/KC/LLM/HaikuArn), like every
    other generation call.
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
        response = bedrock_runtime(llm_region).converse(
            modelId=haiku_model_arn or config.HAIKU_ARN,
            messages=[{"role": "user", "content": [{"text": user_message}]}],
            system=[{"text": title_system_prompt}],
            # Haiku 5.5 rejects non-default temperature and thinks by default;
            # a title needs neither.
            inferenceConfig={"maxTokens": 30},
            additionalModelRequestFields={"thinking": {"type": "disabled"}},
        )
        parts = response["output"]["message"]["content"]
        title = "".join(p.get("text", "") for p in parts).strip()
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
    raw_history = _sanitize_history(fetch_recent_messages(db_connection, chat_session_id))
    
    # 3. Save User Message
    try:
        if save_user_message:
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

    # Ready documents replace typed questions, journey guidance and the steps
    # of the situations they cover. A journey with none keeps the typed text.
    coverage = fetch_journey_coverage(db_connection)
    catalog = apply_document_coverage(config.JOURNEY_CATALOG, coverage)
    previous_section = get_guide_state(db_connection, chat_session_id) if phase != DETECTIVE else None
    if previous_section and previous_section.get("label"):
        search_query = f"{search_query}\n\n{previous_section['label']}"

    # 6. Build the phase prompt.
    static_system_prompt, num_retrieval_results, phase_name, phase_instructions, model_arn = get_current_prompt(
        phase=phase,
        exchange_count=exchange_count,
        journey_state=journey_state,
        route=route,
        catalog=catalog,
        outlines=outlines_for(coverage),
    )

    # 7. RAG Retrieval (using the routed query). Journey documents are hidden
    # from this search; they are retrieved separately below. Detective turns
    # retrieve nothing: with library titles and URLs in context the model
    # links resources before the family's situation is known.
    sources: List[Dict[str, Any]] = []
    if num_retrieval_results > 0:
        sources = retrieve_from_pgvector(
            search_query,
            db_connection,
            region,
            num_results=num_retrieval_results,
        )

    sections: List[Dict[str, Any]] = []
    if phase != DETECTIVE:
        document_ids = document_ids_for_turn(route, coverage)
        if document_ids:
            # A failure raises GuidelineRetrievalError, which get_response turns
            # into its generic error reply: a journey with reviewed guides is
            # never answered from the library alone because its guides could
            # not be read (finding f-50122d26).
            sections = retrieve_guideline_sections(
                search_query,
                db_connection,
                region,
                previous_section=previous_section,
                document_ids=document_ids,
            )
    routing_ctx = {
        "phase": phase,
        "route": route,
        "state": routing_state,
        "has_guides": bool(sections),
        "guide_count": len(sections),
        "previous_section": previous_section,
    }

    # 8. Guide sections are labeled [G1..Gn]; library sources are numbered
    # separately from [1]. The returned list is still sections + library;
    # get_response splits it with routing_ctx["guide_count"].
    if sections:
        context_block = format_context_for_prompt(sources)
        sources = list(sections) + list(sources)
        dynamic_prompt = f"""{phase_instructions}

{GUIDE_CITE_NOTE}

<guide_sections>
{format_sections(sections, label_prefix="G")}
</guide_sections>

<retrieved_context>
{context_block}
</retrieved_context>
{data_block_note("retrieved_context")}
"""
    elif phase == DETECTIVE:
        dynamic_prompt = phase_instructions
    else:
        context_block = format_context_for_prompt(sources)
        dynamic_prompt = f"""{phase_instructions}

<retrieved_context>
{context_block}
</retrieved_context>
{data_block_note("retrieved_context")}
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


def _fallback_resources(
    sources: List[Dict[str, Any]],
    answer_text: str,
    limit: int = GUIDELINE_FALLBACK_RESOURCE_COUNT,
    min_score: float = DEFAULT_MIN_SCORE,
) -> List[Dict[str, Any]]:
    """
    Library resources to show under "More resources" when a guideline-mode
    guidance answer cited only its guide section. Display-only: they are not
    grounding and are never passed to the grounding check. Guides are never
    returned.

    Order: resources whose public URL appears in the answer (linked but not
    cited, in retrieval order), then the rest at or above `min_score` (the active
    embedding space's effective value; DEFAULT_MIN_SCORE when none is set) by
    descending score.
    """
    resources = [s for s in sources if s.get("source_type") != GUIDELINE_SOURCE_TYPE]
    linked = []
    for source in resources:
        url = public_http_url(source.get("url") or source.get("uri"))
        if url and url in (answer_text or ""):
            linked.append(source)
    rest = sorted(
        (
            s for s in resources
            if not any(s is chosen for chosen in linked) and (s.get("score") or 0) >= min_score
        ),
        key=lambda s: s.get("score") or 0,
        reverse=True,
    )
    return (linked + rest)[:limit]


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


def _close_stream(stream):
    """Stop reading the model stream and release its connection."""
    close = getattr(stream, "close", None)
    if callable(close):
        try:
            close()
        except Exception as e:
            logger.warning("Failed to close model stream: %s", type(e).__name__)

def get_response(
    query: str,
    region: str,
    llm_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    db_connection,
    save_user_message: bool = True,
    stream_callback=None,
) -> Dict[str, Any]:
    
    usage_info = {}
    is_under_limit = True

    try:
        if user_id:
            # Check and count in one atomic step, before the guardrail and any
            # Bedrock call. A user without a users row is refused.
            is_under_limit, usage_info = reserve_daily_message(user_id, db_connection)
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

        # Every message goes through the input guardrail; no request field can
        # skip it.
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
                # Not `query`: the next turn replays history into Bedrock
                # without re-screening it.
                insert_message(db_connection, chat_session_id, 'user', BLOCKED_INPUT_PLACEHOLDER, sources=None, warning=None)
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

    except EmbeddingSpaceError:
        # Fail loud: main.py turns this into an `error` event. Never answer from
        # a mismatched or missing embedding space, and do not hide it behind the
        # generic "An error occurred." reply below.
        raise
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

    char_cap = answer_char_cap()
    max_tokens = generation_max_tokens(char_cap)

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
            # Haiku 5.5 rejects non-default temperature/top_p, so no
            # sampling settings are sent. Thinking is on by default there;
            # keep it off so the streamed reply starts with the answer.
            "inferenceConfig": {
                "maxTokens": max_tokens,
            },
            "additionalModelRequestFields": {
                "thinking": {"type": "disabled"},
            },
        }

    bedrock = bedrock_runtime(llm_region)
    
    full_response_text = ""
    usage: Dict[str, Any] = {}
    stop_reason = None
    answer_started = False
    answer_text = ""
    generation_failed = False
    cited_indices = []
    parsed_indices = None
    expect_answer_tags = phase_name == "SUGGESTION"
    # The retired guideline-only pipeline set mode. The merged path sets
    # has_guides when this turn retrieved a journey's documents. Both hide
    # guide citations and record the chosen section. Only the old pipeline
    # skipped journey and routing state.
    exclusive_guideline = routing_ctx.get("mode") == "guideline"
    has_guides = exclusive_guideline or bool(routing_ctx.get("has_guides"))
    # The merged path labels guides G1..Gn and numbers library sources from 1;
    # the retired pipeline keeps one shared numbering.
    merged_guides = has_guides and not exclusive_guideline
    guide_count = int(routing_ctx.get("guide_count") or 0) if merged_guides else 0
    # Hidden metadata tags that must never reach the stream. Guideline mode
    # adds <guide_state>; standard mode keeps its original tag lists.
    stream_stop_tags = ["</answer>", "<cited", "<detective_state", "<journey_state"]
    stream_hold_tags = [
        "</answer>", "<cited_indices>", "</cited_indices>", "<cited", "<detective_state>", "</detective_state>",
        "<journey_state>", "</journey_state>",
    ]
    if has_guides:
        stream_stop_tags.append("<guide_state")
        stream_hold_tags.extend(["<guide_state>", "</guide_state>"])

    # Every streamed character passes the output guardrail first (finding
    # f-609f1065). No socket, no screener: nothing streams on REST.
    screener = (
        OutputStreamScreener(stream_callback, invoke_output_guardrail, config.REGION)
        if stream_callback else None
    )

    try:
        response = bedrock.converse_stream(**request_payload)
        stream = response.get("stream", [])
        for event in stream:
            if "messageStop" in event:
                stop_reason = event["messageStop"].get("stopReason")
            elif "metadata" in event:
                usage = event["metadata"].get("usage") or {}
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
                        
                    # 4. Strip internal storage URIs before anything reaches the
                    # client. A URI or link may be split across deltas, so only
                    # the settled prefix is sanitized and streamed; the held-back
                    # tail arrives with the next delta or the 'complete' event.
                    settled = safe_text if stop_found else safe_text[:stream_settled_length(safe_text)]
                    visible = strip_internal_links(settled)[:char_cap]

                    # 5. Screen before anything reaches the client. Leading
                    # whitespace (the newline after <answer>) is never part of
                    # the saved answer.
                    if screener is not None:
                        screener.offer(visible.lstrip())
                        if screener.stopped:
                            break

        if screener is not None and screener.stopped:
            _close_stream(stream)
        else:
            _log_generation_usage(usage, stop_reason, max_tokens)
            # Parse final answer text properly
            final_answer_match = re.search(r'<answer>(.*?)</answer>', full_response_text, re.DOTALL)
            if final_answer_match:
                answer_text = final_answer_match.group(1)
            else:
                # Detective phase, or a reply without </answer>: keep the text
                # before the first hidden tag.
                answer_text = full_response_text.split("<answer>", 1)[-1]
            # Hidden blocks the model put inside the answer are removed too.
            answer_text = strip_hidden_tags(answer_text)

            # The visible answer is held to the per-answer cap before it is
            # screened, saved or sent. The stream above stops at the same length;
            # 'complete' carries the cut text. Hidden tags are still parsed.
            if len(answer_text) > char_cap:
                logger.info("Answer cut to the per-answer cap (chars=%d, cap=%d)", len(answer_text), char_cap)
                answer_text = cap_answer_length(answer_text, char_cap)

            # Parse cited_indices tolerantly: one malformed token must not drop
            # every citation.
            if merged_guides:
                # G<n> is guide section n, a plain <n> is library source n.
                # Mapped onto positions in sources (sections, then library).
                refs = parse_cited_refs(full_response_text)
                if refs is not None:
                    guide_refs, library_refs = refs
                    parsed_indices = guide_refs + library_refs
                    cited_indices = (
                        [n for n in guide_refs if 1 <= n <= guide_count]
                        + [guide_count + n for n in library_refs if n >= 1]
                    )
            else:
                parsed_indices = parse_cited_indices(full_response_text)
                if parsed_indices is not None:
                    cited_indices = parsed_indices
            if parsed_indices is None and sources and "<answer>" in full_response_text:
                # Guidance reply without the citation block: sources can't be shown.
                logger.warning(
                    "Guidance reply had no <cited_indices> block (phase=%s, retrieved=%d)",
                    phase_name,
                    len(sources),
                )

    except Exception as e:
        logger.error(f"Generation Failed: {e}")
        answer_text = GENERATION_ERROR_TEXT
        generation_failed = True
        cited_indices = []

    # Every answer goes through the output guardrail before it is saved or sent
    # in 'complete', which replaces any text already streamed. A blocked answer
    # keeps no citations and is not trusted for grounding, state or the title.
    # A block during the stream has the same outcome as a blocked final answer.
    # A guardrail error on this final check fails closed, like the input check.
    output_blocked = False
    if screener is not None and screener.blocked_result is not None:
        # Blocked mid-stream: same outcome as a blocked final answer.
        output_blocked = True
        answer_text = screener.blocked_result['text']
        cited_indices = []
        parsed_indices = []
        full_response_text = ""
    elif answer_text and not generation_failed:
        try:
            screened = invoke_output_guardrail(answer_text, config.REGION)
        except Exception as e:
            logger.error(f"Output guardrail invocation failed: {type(e).__name__}")
            screened = None
        if screened is None:
            answer_text = GENERATION_ERROR_TEXT
            generation_failed = True
            cited_indices = []
        elif screened['action'] == ACTION_BLOCKED:
            output_blocked = True
            answer_text = screened['text']
            cited_indices = []
            parsed_indices = []
            full_response_text = ""
        elif screened['action'] == ACTION_ANONYMIZED:
            answer_text = screened['text']

    # http(s) links to anything other than a library source retrieved this
    # turn become plain text, so only links that also get a source card stay
    # clickable. Done on answer_text so grounding, linked sources, the saved
    # message and 'complete' all see the same text. Text already streamed
    # may have shown the link; 'complete' replaces it.
    if answer_text and not (output_blocked or generation_failed):
        answer_text, removed_links = strip_unverified_links(answer_text, sources)
        if removed_links:
            # Counts only: never the message text or URLs.
            logger.info("Unverified links removed from answer: removed=%d", removed_links)

    # Older history turns may contain internal links the model could echo.
    final_answer_text = strip_internal_links(answer_text)

    # Send the screened rest of the answer before the slower grounding check.
    if screener is not None:
        screener.finish(
            final_answer_text if not (output_blocked or generation_failed) else None
        )

    # Full cited sources feed the grounding verifier; only the trimmed public
    # projection is streamed to the client and persisted with the message.
    # Guide citations stay internal: they ground the answer but are never
    # streamed or saved, so families never see guide names. The section in
    # use is still recorded for admins in chat_sessions.metadata.guide_state.
    #
    # Library sources the answer links ([Title](URL)) also get a card and are
    # grounding, even when <cited_indices> leaves them out, is missing or is
    # []. Matched on the answer before strip_internal_links, since uploaded
    # documents are shown to the model by internal URI. Only sources retrieved
    # this turn can match; guide sections never do.
    cited_sources = select_cited_sources(sources, cited_indices)
    linked_sources: List[Dict[str, Any]] = []
    if expect_answer_tags and answer_text and not (output_blocked or generation_failed):
        linked_sources = select_linked_sources(sources, answer_text)
    used_sources = merge_cited_and_linked(cited_sources, linked_sources)
    library_used = [s for s in used_sources if s.get("source_type") != GUIDELINE_SOURCE_TYPE]
    public_sources = [to_public_source(source) for source in library_used]
    guide_state = None
    if has_guides:
        # Merged path: only guide sections can be chosen, so "G2" and "2" both mean guide 2.
        guide_state = parse_guide_state(
            full_response_text, sources[:guide_count] if merged_guides else sources
        )

    # Guideline mode: a guidance answer that cited only its guide section
    # still keeps "More resources", using library resources only (never
    # guides). An explicit [] marks a clarifying turn, which shows none.
    # Linked sources come first; fallback items fill the rest, are
    # display-only and are not sent to grounding.
    fallback_count = 0
    cited_library = any(s.get("source_type") != GUIDELINE_SOURCE_TYPE for s in cited_sources)
    if (has_guides and guide_state and not cited_library and parsed_indices != []
            and answer_text and not generation_failed):
        shown = merge_cited_and_linked(
            library_used,
            _fallback_resources(
                sources, answer_text, min_score=effective_min_score(db_connection, region)
            ),
        )
        shown = shown[:max(GUIDELINE_FALLBACK_RESOURCE_COUNT, len(library_used))]
        fallback_count = len(shown) - len(library_used)
        public_sources = [to_public_source(s) for s in shown]

    library_retrieved = sum(1 for s in sources if s.get("source_type") != GUIDELINE_SOURCE_TYPE)
    if (expect_answer_tags and not public_sources and library_retrieved and answer_text
            and not output_blocked and not generation_failed):
        # Counts only: never the message text or URLs.
        logger.warning(
            "Answer turn ended with no public sources (library_retrieved=%d, guides=%d, "
            "cited_block=%s, cited=%d, linked=%d)",
            library_retrieved, len(sources) - library_retrieved,
            parsed_indices is not None, len(cited_sources), len(linked_sources),
        )

    warning_text = None
    intervention_result = None

    # Guideline mode: a clarifying question cites no section, so there is
    # nothing to verify; answers are checked against the full sections.
    run_grounding_check = (
        phase_name == "SUGGESTION" and not output_blocked and (not has_guides or bool(used_sources))
    )

    if run_grounding_check and answer_text and not generation_failed:
        try:
            intervention_result = assess_response(
                query=query,
                answer_text=answer_text,
                sources=used_sources,
                llm_region=llm_region,
                verifier_model_id=config.HAIKU_ARN,
            )
            warning_text = intervention_result.get("warning_text")
        except Exception as e:
            logger.error(f"Intervention Failed: {e}")
            warning_text = None
            intervention_result = None

    _save_ai_response(
        db_connection,
        chat_session_id,
        final_answer_text,
        public_sources,
        warning_text
    )

    # The chosen guide section is stored for the next turn and for admins.
    # Journey and routing state are still saved on the merged path.
    if has_guides:
        logger.info(
            "Guideline turn: sources=%d cited=%d linked=%d fallback_resources=%d selected_section=%s",
            len(sources), len(cited_sources), len(linked_sources), fallback_count,
            guide_state["section_key"] if guide_state else None,
        )
        if guide_state and answer_text and not generation_failed:
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
    if full_response_text and not exclusive_guideline:
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
    if (not exclusive_guideline and not output_blocked
            and answer_text and not generation_failed):
        try:
            # Journey/situation keys only (no text) for feedback analytics.
            journeys_touched, clusters_touched = touched_keys(
                routing_ctx["route"], routing_ctx["phase"], config.JOURNEY_CATALOG
            )
            next_state = routing_ctx["state"].advance(
                routing_ctx["phase"], journeys_touched, clusters_touched
            )
            routing_metadata = next_state.to_metadata(routing_ctx["route"])
            if guide_state:
                # Admin feedback analytics only (journeyPrompts.js). Guest
                # session reads strip it (chatSessionHandler.js).
                routing_metadata["guide_section"] = {
                    "document_id": guide_state["document_id"],
                    "section_key": guide_state["section_key"],
                }
            save_routing_state(
                db_connection,
                chat_session_id,
                routing_metadata,
            )
            db_connection.commit()
        except Exception as e:
            db_connection.rollback()
            logger.warning(f"Failed to save routing state: {e}")

    generated_title = None
    if final_answer_text and not output_blocked and not generation_failed:
        try:
            current_title = get_session_title(db_connection, chat_session_id)
            is_untitled = current_title is None or current_title.strip() in ("", "New Session")
            if is_untitled and get_exchange_count(chat_session_id, db_connection) == 1:
                generated_title = _generate_session_title(
                    query, final_answer_text, llm_region, haiku_model_arn=config.HAIKU_ARN
                )
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