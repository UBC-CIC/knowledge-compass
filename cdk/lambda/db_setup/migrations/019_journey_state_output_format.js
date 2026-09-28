/**
 * 019_journey_state_output_format.js
 *
 * Adds the <journey_state> output tag to the suggestion-phase output format.
 *
 * After each suggestion-phase response, the model now outputs a structured
 * journey state block that is:
 *   - Parsed by chat.py and stored in chat_sessions.metadata->>'journey_state'
 *   - Fed back into the suggestion prompt on subsequent turns via logic.py
 *   - Never streamed to the user (the streaming parser stops at </answer>)
 *
 * This enables multi-turn journey awareness without additional LLM calls.
 *
 * The chat_sessions.metadata JSONB column already exists (migration 000) and
 * was previously unused, so no schema migration is needed.
 */

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE system_messages
       SET content = $msg$You MUST wrap your response inside <answer> tags.
After your answer, you MUST list the integer indices of the sources you actively used
inside <cited_indices> tags as a JSON array (e.g. <cited_indices>[1, 3]</cited_indices>).
If no sources were used, output <cited_indices>[]</cited_indices>.

After cited_indices, you MUST output a <journey_state> block — a brief structured
summary of where this family is in their journey. This is stored internally and
fed back to you on future turns so you maintain context. Keep it concise (3-5 lines).
Format:
<journey_state>
journey: J1 or J2
situation: [letter A-O from the situation clusters]
stage: [brief description of where the family is right now]
actions_taken: [comma-separated list of what the family has already done]
next_need: [the single most likely next thing the family will need help with]
</journey_state>

Within your <answer>:
- Start with a direct 2-4 sentence summary of where the family is and their next step.
- Follow with a "Here's what to do:" section. Use bold action titles, nested bullets, and italic sample wording where it helps.
- Add short sections such as "Why this matters" or "What to document" when useful.
- End with the single next immediate step, and optionally one follow-up question in bold.
- When a retrieved source supports the next step, include a markdown link in the answer: [Title](URL), with one short sentence on why it helps.
- Do NOT add a separate "Sources" heading — the system lists sources below the answer.
- Only include a source index if the content of that source directly supports a specific claim.

Example format:
<answer>
You're at [stage]. Your next step is [action].

Here's what to do:

**Send a follow-up email.** Keep it brief:
- Sample wording: *"I'm following up on my previous request. I would appreciate an update."*

**Why this matters:**
- Written documentation creates a clear record.

A helpful resource: [Source title](https://example.com/resource).

Once you send that, wait 5–7 business days. If you don't hear back, we can talk about the next step.

**Did the school put any of this in writing?**
</answer>
<cited_indices>[1, 2]</cited_indices>
<journey_state>
journey: J1
situation: D
stage: Parent has requested decision in writing, awaiting school response
actions_taken: identified situation, understood reason, sent written request
next_need: follow-up guidance if school does not respond
</journey_state>$msg$,
           character_limit = 4500,
           created_at = now()
     WHERE type = 'output_format_suggestion'
       AND is_active = true;
  `);
};

exports.down = (pgm) => {
  // Restore the previous output_format_suggestion (from migration 004).
  pgm.sql(`
    UPDATE system_messages
       SET content = $msg$You MUST wrap your response inside <answer> tags.
After your answer, you MUST list the integer indices of the sources you actively used
inside <cited_indices> tags as a JSON array (e.g. <cited_indices>[1, 3]</cited_indices>).
If no sources were used, output <cited_indices>[]</cited_indices>.

Within your <answer>:
- Start with a direct 2-4 sentence summary of where the family is and their next step.
- Follow with a "Here's what to do:" section. Use bold action titles, nested bullets, and italic sample wording where it helps.
- Add short sections such as "Why this matters" or "What to document" when useful.
- End with the single next immediate step, and optionally one follow-up question in bold.
- When a retrieved source supports the next step, include a markdown link in the answer: [Title](URL), with one short sentence on why it helps.
- Do NOT add a separate "Sources" heading — the system lists sources below the answer.
- Only include a source index if the content of that source directly supports a specific claim.

Example format:
<answer>
You're at [stage]. Your next step is [action].

Here's what to do:

**Send a follow-up email.** Keep it brief:
- Sample wording: *"I'm following up on my previous request. I would appreciate an update."*

**Why this matters:**
- Written documentation creates a clear record.

A helpful resource: [Source title](https://example.com/resource).

Once you send that, wait 5–7 business days. If you don't hear back, we can talk about the next step.

**Did the school put any of this in writing?**
</answer>
<cited_indices>[1, 2]</cited_indices>$msg$,
           character_limit = 3500,
           created_at = now()
     WHERE type = 'output_format_suggestion'
       AND is_active = true;
  `);
};
