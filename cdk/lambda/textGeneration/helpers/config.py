import logging
import boto3
import os
from helpers.crud import fetch_system_config

logger = logging.getLogger(__name__)

# CONFIGURATION CACHE
_CONFIG_LOADED = False

# ------------------------------------------------------------------
# DEFAULT VALUES (Fallbacks)
# ------------------------------------------------------------------

KB_ID = None

HAIKU_ARN = None
SONNET_ARN = None

REGION = os.getenv("REGION", "ca-central-1")
LLM_REGION = os.getenv("LLM_REGION", "us-west-2")

GUARDRAIL_ID = os.getenv('GUARDRAIL_ID')
GUARDRAIL_VERSION = os.getenv('GUARDRAIL_VERSION')

KB_SECRET_NAME = os.getenv('KB_SECRET_NAME')

# Retrieval backend selector (pgvector migration, Phase 2).
# When true, retrieval uses the unified pgvector corpus (chunks/sources) instead
# of the Bedrock Knowledge Base. Defaults to false so the existing KB path stays
# the default until pgvector retrieval has been validated.
USE_PGVECTOR_RETRIEVAL = os.getenv('USE_PGVECTOR_RETRIEVAL', 'false').strip().lower() in ('1', 'true', 'yes')

# Chat Configuration
MAX_MESSAGES_PER_DAY = 45
MIN_EXCHANGES_BEFORE_SUGGEST = 4
MAX_CHARACTERS_PER_USER_MESSAGE = 2000
MAX_CHARACTERS_PER_AI_MESSAGE = 5000

# Bedrock Configuration
SEARCH_TYPE = "HYBRID"
MAX_TOKENS = 4000
TEMPERATURE = 0.15
TOP_P = 0.5

# Intervention Thresholds
SUPPORT_SCORE_THRESHOLD = 0.25
SCOPE_ALIGNMENT_SCORE_THRESHOLD = 0.25
GROUNDED_THRESHOLD = 0.75
PARTIALLY_GROUNDED_THRESHOLD = 0.50

# ------------------------------------------------------------------
# Prompts & System Messages (Inclusion Canada defaults / fallbacks)
# ------------------------------------------------------------------
# These are fallbacks used when the DB has no active row for a type. The DB
# (migration 002_inclusion_canada_prompts.js) is the runtime source of truth;
# per Decision 4 both layers carry Inclusion Canada content so the app is correct
# even before the DB is re-seeded. Keep these in sync with migration 002.

ROLE = """
You are a compassionate, knowledgeable guide helping families navigate inclusive education in Canada, built for Inclusion Canada. You serve parents, support persons, and family members across two journeys: Journey 1 — a child is currently being excluded or placed on a reduced school schedule; Journey 2 — a family is planning for the future (transitions, course selection, support quality, extracurricular inclusion, teacher accountability). Help families understand their situation, take clear next steps, and find the right resources — do not provide legal advice or make decisions for them.
""".strip()

GUARDRAILS = """
- Never provide legal advice, legal conclusions, or interpretations of legislation.
- Never assign blame, bad faith, or negative intent to school staff.
- Never use adversarial or confrontational framing.
- Never use deficit-based language about the child or their disability.
- Always use plain, parent-friendly language — avoid jargon.
- Always focus on collaborative problem-solving with the school.
- Never overwhelm with options — present 2-3 at most.
- Always end with a clear, specific next step the family can take.
- Only draw on information from the retrieved knowledge base. Do not speculate.
- If the knowledge base does not have enough information, say so directly.
""".strip()

LANGUAGE_GUIDELINES = """
Follow Inclusion Canada's preferred language: use person-first disability language by default; avoid deficit or outdated terms; use "they/them" when gender is unknown; use "support person" not "caregiver"; use "People in Canada" not "Canadians"; use "died by suicide" not "committed suicide". When unsure of a person's preference, ask.
""".strip()

DETECTIVE_PHASE_PROMPT = """
CURRENT STATUS: Exchange {exchange_count} of at least {min_exchanges}.
{readiness_note}

Ask exactly ONE warm, focused question. Acknowledge what the parent said first. First identify the family's journey (Journey 1: current exclusion / reduced schedule; Journey 2: future planning), then understand where they are in it. STRICT RULES: ONE question per turn; do NOT suggest resources or actions yet unless {may_suggest} is True; never assume gender, disability type, or province.
""".strip()

SUGGESTION_PHASE_PROMPT = """
Identify which journey stage best fits the conversation, then respond accordingly. Journey 1 covers involuntary partial day attendance from recognition through documentation, meetings, non-response, denial, rights/advocacy, and escalation. Journey 2 covers course selection, transition planning, support quality/EA advocacy, extracurricular inclusion, and teacher accountability. Validate, explain in plain language, and give a clear next step.
""".strip()

OUTPUT_FORMAT_DETECTIVE = """
1. One warm sentence acknowledging what the parent shared.
2. One focused question — no more than one.
Do NOT list options. Do NOT suggest actions or resources. End with a question mark.
""".strip()

OUTPUT_FORMAT_SUGGESTION = """
You MUST wrap your response inside <answer> tags. After your answer, you MUST list the integer indices of the sources you actively used inside <cited_indices> tags as a JSON array (e.g. <cited_indices>[1, 3]</cited_indices>). If no sources were used, output <cited_indices>[]</cited_indices>. Within your <answer>: start with a direct 2-4 sentence summary of where the family is and their next step, then bullet points for supporting details. Do NOT include a Sources section. Only cite a source index if that source directly supports a specific claim.
""".strip()

INITIAL_PROMPT = "Introduce yourself as the Inclusion Canada education guide and invite the family to share what is happening with their child's schooling." # Fallback

WELCOME_MESSAGE = """
Hi, I'm here to help you navigate your child's education. Whether your child is being sent home early or excluded from school activities, or you're planning for their future — you don't have to figure this out alone. Tell me what's been happening. What's going on with your child's schooling right now?
""".strip()


# ------------------------------------------------------------------
# MODEL ARN CACHING (SSM)
# ------------------------------------------------------------------

def load_config(db_connection):
    """
    Loads configuration from DB and updates module globals.
    Uses caching to avoid DB hits on every request if container is warm.
    """
    global _CONFIG_LOADED
    global MAX_MESSAGES_PER_DAY, MIN_EXCHANGES_BEFORE_SUGGEST, MAX_CHARACTERS_PER_USER_MESSAGE, MAX_CHARACTERS_PER_AI_MESSAGE, TEMPERATURE, TOP_P, SUPPORT_SCORE_THRESHOLD, SCOPE_ALIGNMENT_SCORE_THRESHOLD, GROUNDED_THRESHOLD, PARTIALLY_GROUNDED_THRESHOLD
    global GUARDRAILS, ROLE, LANGUAGE_GUIDELINES, DETECTIVE_PHASE_PROMPT, SUGGESTION_PHASE_PROMPT
    global OUTPUT_FORMAT_DETECTIVE, OUTPUT_FORMAT_SUGGESTION, INITIAL_PROMPT, WELCOME_MESSAGE
    global KB_ID
    global HAIKU_ARN, SONNET_ARN
    global GUARDRAIL_ID, GUARDRAIL_VERSION

    if _CONFIG_LOADED:
        return

    logger.info("Loading system config from DB and Secrets Manager...")
    
    # Load Knowledge Base ID from Secrets Manager
    if not KB_ID:
        try:
            client = boto3.client('secretsmanager')
            response = client.get_secret_value(SecretId=KB_SECRET_NAME)
            KB_ID = response.get('SecretString')
            logger.info("Successfully loaded KB_ID from Secrets Manager.")
        except Exception as e:
            logger.error(f"Failed to load KB_ID from Secrets Manager: {e}")
            raise

    if not HAIKU_ARN:
        ssm_param = os.environ.get("HAIKU_ARN")
        if not ssm_param:
            raise RuntimeError("Missing environment variable for HAIKU_ARN")
        ssm = boto3.client("ssm")
        try:
            HAIKU_ARN = ssm.get_parameter(Name=ssm_param)["Parameter"]["Value"]
        except Exception as e:
            raise RuntimeError(f"Failed to fetch SSM parameter {ssm_param}: {e}")

    if not SONNET_ARN:
        ssm_param = os.environ.get("SONNET_ARN")
        if not ssm_param:
            raise RuntimeError("Missing environment variable for SONNET_ARN")
        ssm = boto3.client("ssm")
        try:
            SONNET_ARN = ssm.get_parameter(Name=ssm_param)["Parameter"]["Value"]
        except Exception as e:
            raise RuntimeError(f"Failed to fetch SSM parameter {ssm_param}: {e}")

    if not GUARDRAIL_ID: 
        raise RuntimeError(
            "Missing required environment variables: GUARDRAIL_ID"
        )
    
    if not GUARDRAIL_VERSION: 
        raise RuntimeError(
            "Missing required environment variables: GUARDRAIL_VERSION"
        )

    data = fetch_system_config(db_connection)

    # 1. Update System Settings
    settings = data.get('settings', {})
    if settings:
        MAX_MESSAGES_PER_DAY = settings.get('max_messages_per_day', MAX_MESSAGES_PER_DAY)
        MIN_EXCHANGES_BEFORE_SUGGEST = settings.get('min_messages_before_suggest', MIN_EXCHANGES_BEFORE_SUGGEST)
        MAX_CHARACTERS_PER_USER_MESSAGE = settings.get('max_characters_per_user_message', MAX_CHARACTERS_PER_USER_MESSAGE)
        MAX_CHARACTERS_PER_AI_MESSAGE = settings.get('max_characters_per_ai_message', MAX_CHARACTERS_PER_AI_MESSAGE)
        TEMPERATURE = settings.get('temperature', TEMPERATURE)
        TOP_P = settings.get('top_p', TOP_P)
        SUPPORT_SCORE_THRESHOLD = settings.get('support_score_threshold', SUPPORT_SCORE_THRESHOLD)
        SCOPE_ALIGNMENT_SCORE_THRESHOLD = settings.get('scope_alignment_score_threshold', SCOPE_ALIGNMENT_SCORE_THRESHOLD)
        GROUNDED_THRESHOLD = settings.get('grounded_threshold', GROUNDED_THRESHOLD)
        PARTIALLY_GROUNDED_THRESHOLD = settings.get('partially_grounded_threshold', PARTIALLY_GROUNDED_THRESHOLD)
        # Note: specialization_list (UBC) is intentionally no longer read; the
        # column remains until the Phase 6 cleanup migration removes it.

    # 2. Update System Messages (Inclusion Canada)
    msgs = data.get('messages', {})
    if msgs:
        GUARDRAILS = msgs.get('guardrails', GUARDRAILS)
        ROLE = msgs.get('system_role', ROLE)
        LANGUAGE_GUIDELINES = msgs.get('language_guidelines', LANGUAGE_GUIDELINES)
        DETECTIVE_PHASE_PROMPT = msgs.get('detective_phase_prompt', DETECTIVE_PHASE_PROMPT)
        SUGGESTION_PHASE_PROMPT = msgs.get('suggestion_phase_prompt', SUGGESTION_PHASE_PROMPT)
        OUTPUT_FORMAT_DETECTIVE = msgs.get('output_format_detective', OUTPUT_FORMAT_DETECTIVE)
        OUTPUT_FORMAT_SUGGESTION = msgs.get('output_format_suggestion', OUTPUT_FORMAT_SUGGESTION)
        INITIAL_PROMPT = msgs.get('initial_prompt', INITIAL_PROMPT)
        WELCOME_MESSAGE = msgs.get('welcome_message', WELCOME_MESSAGE)

    _CONFIG_LOADED = True

    logger.info("System config loaded successfully.")
