# User Stories

## What These Are

Inclusion Canada user stories that define the conversational flows for Knowledge Compass. They directly drove the prompt design in `textgen_v1.ipynb` and should be used as the acceptance criteria when evaluating the assistant's responses.

---

## Structure

Each story follows a consistent four-part format:
1. **Situation** — parent context in plain language
2. **Acceptance Criteria** — what the system must do (8-10 behaviours)
3. **User Flow / Conversation** — numbered prototype conversation (7-8 steps) showing exact system behaviour including sample wording
4. **Content Required** — knowledge the system needs to respond correctly
5. **Notes** — complexity estimate (Small/Medium, 1-3 days) and testing pass/fail scenarios

---

## Coverage

### Journey 1 — Involuntary Partial Day Attendance Navigation
Child is currently being excluded or placed on a reduced schedule without family choice.

| Feature | Stories | Focus |
|---|---|---|
| Feature 1 (`User_Stories_Journey_1_Feature_1.md`) | 111–11I (15 stories) | Step-by-step guidance: what to do, document, request, escalate |
| Feature 2 (`User_Stories_Journey_1_Feature_2.md`) | 121–12C (12 stories) | Plain language explanations: what PDA is, types, consequences |
| Feature 3 (`User_Stories_Journey_1_Feature_3.md`) | 131–13F (15 stories) | Rights and advocacy: duty to accommodate, CRPD, appeals, lawyers |

### Journey 2 — Transitions to Public School and Community
Family is planning for the child's future: courses, transitions, supports, extracurriculars.

| Feature | Stories | Focus |
|---|---|---|
| Feature 1 (`User_Stories_Journey_2_Feature_1.md`) | 211–21B (11 stories) | Keeping options open: credits, prerequisites, graduation pathways |
| Feature 3 (`User_Stories_Journey_2_Feature_3.md`) | 231–238 (8 stories) | Transition planning: timelines, meetings, what to expect |
| Feature 4 (`User_Stories_Journey_2_Feature_4.md`) | 241–247 (7 stories) | Support quality: EA effectiveness, independence, scaffolding |

**Total: 68 stories across 5 features and 2 journeys.**

---

## How They Map to the Prompt

The assistant uses a two-phase prompt structure:

**Detective phase** (exchanges 1–3): asks one question per turn to identify which journey the family is on and where they are in it. The question priorities in `PROMPT_DETECTIVE` are derived from the acceptance criteria across all stories.

**Suggestion phase** (exchange 3+): routes to one of 17 stages based on the conversation. Each stage maps to a cluster of user stories:

| Stage | Maps to Stories |
|---|---|
| 1–2 | 111, 112, 121–123 (recognition, understanding the reason) |
| 3 | 114 (school calling to pick up child) |
| 4–5 | 115, 116 (documentation) |
| 6 | 118 (meeting preparation) |
| 7 | 119 (support plan not followed) |
| 8 | 11A (school not responding) |
| 9 | 11B, 11C (denial, vague response) |
| 10 | 131–135 (rights: duty to accommodate, CRPD, undue hardship) |
| 11 | 11D, 11G, 11H (appeal/escalation) |
| 12 | 11I (bringing someone to a meeting) |
| 13–17 | Journey 2 stories (transitions, supports, extracurriculars) |

---

## Tone Constraints Baked Into Every Story

The acceptance criteria across all stories consistently require the system to:
- Never provide legal advice or legal conclusions
- Never assign blame or bad intent to school staff
- Never use adversarial framing
- Use plain, parent-friendly language
- Focus on collaborative problem-solving
- Always end with a clear next step
- Never overwhelm with too many options (2–3 max)

These are encoded as `PROMPT_GUARDRAILS` in the prompt system.

---

## Language Guidelines

See [`../custom_language_toolkit.md`](../custom_language_toolkit.md) (if present) for Inclusion Canada's preferred terminology — person-first language, Deaf/deaf distinction, Autism identity vs. person-first, "People in Canada" vs "Canadians", etc.

These are encoded as `PROMPT_LANGUAGE_GUIDELINES` in the prompt system and apply to all responses regardless of journey.

---

## Using These Stories for Testing

Each story's **Testing Considerations** section specifies the exact scenarios the system must handle correctly and the common failure modes to watch for. Use these as test cases when evaluating the production assistant:

1. Pick a story (e.g. story 11A — school not responding)
2. Read the User Flow / Conversation section for the expected response pattern
3. Run the conversation in `textgen_v1.ipynb` with the example parent input
4. Verify the response matches the acceptance criteria
5. Test the failure modes listed in Notes → Testing Considerations
