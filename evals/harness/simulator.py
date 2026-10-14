"""
Simulated parent. A Bedrock model plays the scenario's synthetic persona and
answers the assistant's detective questions using only the scenario's hidden
facts, so a journey can reach the guidance turn without a human.
"""

from __future__ import annotations

from typing import Any, Dict, List

from evals.bedrock import converse_text
from evals.schema import MAX_MESSAGE_CHARS, Scenario

SYSTEM_TEMPLATE = """You are role-playing a parent in Canada who is chatting with an online assistant about
their child's schooling. Stay in character for the whole conversation.

Who you are:
{persona}

What is going on (you know this; reveal details only when the assistant asks about them or when they
are needed to answer its question):
{facts}

Your first message to the assistant was:
"{opening}"

Rules:
- Reply as the parent, in 1-3 short sentences, plain and natural, like typing into a chat box.
- Answer the assistant's questions using only the facts above. If it asks something the facts do
  not cover, say you are not sure or give a brief, ordinary answer that does not add new major events.
- Do not volunteer every fact at once, do not ask for legal advice, and do not change the topic.
- If the assistant has already given you guidance, you may ask one short, relevant follow-up question.
- Never mention that you are an AI, a test, or a simulation. Never use real names, schools, phone
  numbers, emails or addresses; keep everything generic ("my daughter", "the principal").
- Output only the parent's next message."""


def _facts(scenario: Scenario) -> str:
    facts = list(scenario.hidden_facts)
    if not facts and scenario.situation_summary:
        facts = [scenario.situation_summary]
    return "\n".join(f"- {f}" for f in facts) or "- (no extra details; keep answers brief)"


def build_system(scenario: Scenario) -> str:
    persona = scenario.persona or "A parent of a school-aged child with a disability; polite, a bit worried, busy with work."
    return SYSTEM_TEMPLATE.format(persona=persona, facts=_facts(scenario), opening=scenario.opening_message)


def build_messages(turns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Converse messages from the simulator's point of view: the assistant's
    replies are the "user" turns it responds to, its own messages are
    "assistant" turns. Starts with the assistant's first reply.
    """
    messages: List[Dict[str, Any]] = []
    for i, turn in enumerate(turns):
        if i > 0:
            messages.append({"role": "assistant", "content": [{"text": turn["user"]}]})
        messages.append({"role": "user", "content": [{"text": turn.get("response") or "(no reply)"}]})
    return messages


class ParentSimulator:
    def __init__(self, client, model_id: str, temperature: float = 0.6):
        self.client = client
        self.model_id = model_id
        self.temperature = temperature

    def reply(self, scenario: Scenario, turns: List[Dict[str, Any]]) -> str:
        """Next parent message given the turns so far (each {user, response})."""
        if not turns:
            return scenario.opening_message
        text = converse_text(
            self.client, self.model_id, build_system(scenario), build_messages(turns),
            max_tokens=300, temperature=self.temperature,
        )
        return " ".join(text.split()).strip().strip('"')[:MAX_MESSAGE_CHARS]
