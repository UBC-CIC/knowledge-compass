
from typing import Optional, Tuple
import helpers.config as config
from helpers.journeys import build_detective_block, build_suggestion_block
from helpers.routing import (
    DETECTIVE,
    PARTIAL,
    ROUTING_MODE_DYNAMIC,
    Route,
    public_phase,
)

DETECTIVE_RETRIEVAL_COUNT = 5
ANSWER_RETRIEVAL_COUNT = 15


def _readiness_note(exchange_count: int) -> str:
    if config.ROUTING_MODE == ROUTING_MODE_DYNAMIC:
        return (
            "Ask one question on this turn. The system moves to guidance automatically "
            "once the family's situation is clear."
        )
    remaining = max(1, config.MIN_EXCHANGES_BEFORE_SUGGEST - exchange_count)
    return f"You must ask at least {remaining} more question(s) before suggesting resources."


def _focus_block(route: Optional[Route]) -> str:
    if route is None or not route.info_needed:
        return ""
    return f"\n\n<focus>\nMost important missing information: {route.info_needed}\n</focus>"


def _routing_hint_block(route: Optional[Route]) -> str:
    if route is None or (route.journey == "UNCLEAR" and route.situation == "UNKNOWN"):
        return ""
    secondary = route.secondary_situation if route.secondary_situation != "NONE" else "none"
    return (
        "\n\n<routing_hint>\n"
        f"journey: {route.journey} | primary situation: {route.situation} | "
        f"secondary situation: {secondary} | urgent: {'yes' if route.urgent else 'no'}\n"
        "This is an automated first read of the latest message. "
        "The conversation history is authoritative.\n"
        "</routing_hint>"
    )


def get_current_prompt(
    phase: str,
    exchange_count: int,
    journey_state: Optional[str],
    route: Optional[Route] = None,
) -> Tuple[str, int, str, str, str]:
    """
    Construct the system prompt for a phase chosen by helpers.routing.decide_phase.

    Returns (static_prompt, retrieval_count, phase_name, phase_instructions, model_arn)
      - static_prompt:      cached block (role + guardrails + language_guidelines)
      - retrieval_count:    how many chunks to retrieve for this phase
      - phase_name:         public phase, "DETECTIVE" | "SUGGESTION" (PARTIAL is
                            reported as SUGGESTION to keep the frontend contract)
      - phase_instructions: the dynamic block for this phase (phase prompt +
                            phase-specific output format), wrapped in XML tags
      - model_arn:          Haiku for detective, Sonnet for partial/suggestion

    Inclusion Canada structure:
      static  = <role> + <guardrails> + <language_guidelines>
      dynamic = <phase> + <output_format>   (retrieved_context is appended by chat.py)
      <phase> = shared base prompt + <journeys> block for the routed journey
                and clusters (helpers/journeys.py) + hint/state/focus blocks
    """
    if phase == DETECTIVE:
        retrieval_count = DETECTIVE_RETRIEVAL_COUNT
        model_arn = config.HAIKU_ARN

        # All legacy placeholders are still supplied so older or admin-edited
        # prompt versions keep formatting; unused keyword arguments are ignored.
        detective_body = config.DETECTIVE_PHASE_PROMPT.format(
            exchange_count=exchange_count + 1,
            min_exchanges=config.MIN_EXCHANGES_BEFORE_SUGGEST,
            readiness_note=_readiness_note(exchange_count),
            may_suggest=False,
        )
        # Journey content is appended after .format() so admin-written
        # journey text may contain braces.
        journeys_block = build_detective_block(config.JOURNEY_CATALOG, route)
        if journeys_block:
            detective_body = f"{detective_body}\n\n{journeys_block}"
        phase_instructions = (
            f"<phase>\n{detective_body}{_focus_block(route)}\n</phase>\n\n"
            f"<output_format>\n{config.OUTPUT_FORMAT_DETECTIVE}\n</output_format>"
        )
    else:
        retrieval_count = ANSWER_RETRIEVAL_COUNT
        model_arn = config.SONNET_ARN

        state_block = ""
        if journey_state:
            state_block = (
                f"\n\n<previous_journey_state>\n"
                f"{journey_state}\n"
                f"</previous_journey_state>\n\n"
                f"Use this context to understand where the family is in their journey. "
                f"Do not repeat completed steps. Build on what has already been discussed."
            )

        extra_blocks = _routing_hint_block(route)
        if phase == PARTIAL:
            extra_blocks += _focus_block(route)
            output_format = config.OUTPUT_FORMAT_PARTIAL
        else:
            output_format = config.OUTPUT_FORMAT_SUGGESTION

        # Only the routed journey and situation clusters (all of them when
        # routing is unclear); see helpers/journeys.select_for_route.
        suggestion_body = config.SUGGESTION_PHASE_PROMPT
        journeys_block = build_suggestion_block(config.JOURNEY_CATALOG, route)
        if journeys_block:
            suggestion_body = f"{suggestion_body}\n\n{journeys_block}"

        phase_instructions = (
            f"<phase>\n{suggestion_body}{state_block}{extra_blocks}\n</phase>\n\n"
            f"<output_format>\n{output_format}\n</output_format>"
        )

    # Static (cached) block: role + guardrails + language guidelines.
    static_prompt = f"""<role>
{config.ROLE}
</role>

<guardrails>
{config.GUARDRAILS}
</guardrails>

<language_guidelines>
{config.LANGUAGE_GUIDELINES}
</language_guidelines>
""".strip()

    return static_prompt, retrieval_count, public_phase(phase), phase_instructions, model_arn
