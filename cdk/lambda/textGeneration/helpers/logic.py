
from typing import Tuple
import helpers.config as config
from helpers.crud import get_exchange_count


def get_current_prompt(chat_session_id: str, db_connection) -> Tuple[str, int, str, str, str]:
    """
    Determines the current conversation phase and constructs the system prompt.

    Returns (static_prompt, retrieval_count, phase_name, phase_instructions, model_arn)
      - static_prompt:      cached block (role + guardrails + language_guidelines)
      - retrieval_count:    how many chunks to retrieve for this phase
      - phase_name:         "DETECTIVE" | "SUGGESTION"
      - phase_instructions: the dynamic block for this phase (phase prompt +
                            phase-specific output format), wrapped in XML tags
      - model_arn:          Haiku for detective, Sonnet for suggestion

    Inclusion Canada structure (Phase 3):
      static  = <role> + <guardrails> + <language_guidelines>
      dynamic = <phase> + <output_format>   (retrieved_context is appended by chat.py)
    """
    # 1. Auto-calculate exchange count (User+AI pairs so far).
    exchange_count = get_exchange_count(chat_session_id, db_connection)

    # 2. Detective vs Suggestion based on how many exchanges have happened.
    #    may_suggest mirrors the notebook: once enough exchanges have occurred the
    #    guide may provide guidance rather than only asking questions.
    min_exchanges = config.MIN_EXCHANGES_BEFORE_SUGGEST
    may_suggest = exchange_count >= min_exchanges

    if not may_suggest:
        phase_name = "DETECTIVE"
        retrieval_count = 5
        model_arn = config.HAIKU_ARN

        remaining = max(0, min_exchanges - exchange_count)
        readiness_note = (
            f"You must ask at least {remaining} more question(s) before suggesting resources."
            if remaining > 0
            else "You may provide guidance now if the situation is already clear."
        )
        # The detective prompt carries runtime placeholders; fill them here.
        detective_body = config.DETECTIVE_PHASE_PROMPT.format(
            exchange_count=exchange_count + 1,
            min_exchanges=min_exchanges,
            readiness_note=readiness_note,
            may_suggest=may_suggest,
        )
        phase_instructions = (
            f"<phase>\n{detective_body}\n</phase>\n\n"
            f"<output_format>\n{config.OUTPUT_FORMAT_DETECTIVE}\n</output_format>"
        )
    else:
        phase_name = "SUGGESTION"
        retrieval_count = 15
        model_arn = config.SONNET_ARN

        phase_instructions = (
            f"<phase>\n{config.SUGGESTION_PHASE_PROMPT}\n</phase>\n\n"
            f"<output_format>\n{config.OUTPUT_FORMAT_SUGGESTION}\n</output_format>"
        )

    # 3. Static (cached) block: role + guardrails + language guidelines.
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

    return static_prompt, retrieval_count, phase_name, phase_instructions, model_arn
