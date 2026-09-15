/**
 * 004_suggestion_output_format.js
 *
 * Aligns the suggestion-phase output contract with the notebook sample in
 * Project Refactoring/textgen_v1.ipynb: summary, "Here's what to do", sample
 * wording, and a single follow-up question. Sources stay outside the answer.
 */

exports.up = (pgm) => {
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

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE system_messages
       SET content = $msg$You MUST wrap your response inside <answer> tags.
After your answer, you MUST list the integer indices of the sources you actively used
inside <cited_indices> tags as a JSON array (e.g. <cited_indices>[1, 3]</cited_indices>).
If no sources were used, output <cited_indices>[]</cited_indices>.

Within your <answer>:
- Start with a direct 2-4 sentence summary of where the family is and their next step.
- Follow with bullet points for supporting details where appropriate.
- Do NOT include a Sources section — sources are handled separately by the system.
- Only include a source index if the content of that source directly supports a specific claim.

Example format:
<answer>
It sounds like you are at [stage]. The most important next step is [action].

- [Detail point]
- [Detail point]
</answer>
<cited_indices>[1, 2]</cited_indices>$msg$,
           character_limit = 2000
     WHERE type = 'output_format_suggestion'
       AND is_active = true;
  `);
};
