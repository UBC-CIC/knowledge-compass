# Prompt simplification: design vs current state

Read-only investigation. No source files were changed.

## Summary answer

1. **The design has already been built, and the code goes further than the design in several places.** `Prompts 2a Simplified (standalone).html` was committed in `d620349 "prompt page simplfied"`. That same commit rewrote the admin Prompts UI and added migrations 025/026. The next commit, `6913c38 "simplify prompt mangement and feedback"`, simplified things further with migrations 027/028, plain-language prompts and a reworked UI. The navigation, page structure, field labels, journey/situation editors, "Preview a reply" drawer and "Add a journey" dialog in `frontend/src/components/Admin/Prompts/*` closely follow the design.
2. **The design's demo data is a stale snapshot.** Its seed prompts are pre-018/pre-024 text: 10-line guardrails, a `J1 or J2 / A-O` partial layout, no `<detective_state>`, and situation `priority`. The repo has moved past all of these. Do not treat the design's "before" text as what is live today.
3. **The only meaningful gap left is prompt wording, not UI or schema.**
   - The design's cleaned-up **"Giving guidance"** (`suggestion_phase_prompt`) is about 3 sentences. The live text (migration 027) still carries the 10 "CROSS-CUTTING RESPONSE PRINCIPLES".
   - The design's cleaned-up **"Asking questions"** (`detective_phase_prompt`) drops the "Rights/concept signals" list. It also makes the last rule journey-neutral ("Never assume the family chose the situation they describe"). The live text keeps the J1-specific "requested the reduced schedule" rule.
   - The design keeps `{exchange_count}` / `{min_exchanges}` / `{readiness_note}` / `{may_suggest}` placeholders in the admin text. The code went the other way: 027 removed them and the app now adds the status line itself. Keep what the code does here.
4. **Design features the code deliberately did not carry forward:**
   - The per-situation "Urgent" toggle (priority was dropped in migration 026; urgency is now decided per turn by the router).
   - Visible journey/situation short codes and the "Short code" field (keys are now internal and auto-generated).
   - Clickable stage cards that dim navigation items (replaced by a one-line `STAGE_SUMMARY`).
   - Always-on character counters (they now appear only at 80% or more of the limit).
   - "Undo cleanup / Undo last publish" (replaced by a per-field "Go back" link).
5. **A real content change would need a new migration (`031_…`).** No API, OpenAPI or schema changes are needed. Rewording the guidance/asking prompts means a new migration plus synchronized fallbacks in `config.py`, `defaultSystemMessages.ts` and `test_prompt_sync.py`.

## 1. What the design proposes

I extracted the content by decoding the bundled template and the gzip/base64 resources (`9a60dde8…` is the `window.KC` model, `12bdee6c…` is the seed data). Only text and structure are summarized here.

**Shell:** "Knowledge Compass · Admin console". The left console nav has Overview, Analytics, **Prompts** ("What the assistant asks and says") and Assistant settings ("Limits and answer checks").

**Prompts page header:** "Shared pages hold rules for every journey. Anything about a specific journey lives only in that journey. Changes reach new messages within about five minutes." There is also a "Preview a reply" button.

**Stage strip (3 clickable cards):**
- *Every reply*: "The assistant".
- *1 Asking questions*: "How it talks" plus the journey's questions.
- *2 Giving guidance*: "How it talks" plus the journey's guidance plus the matching situation steps.

Selecting a card dims the nav items that stage doesn't use.

**Left list:**
- **Shared by every journey:**
  - *The assistant*: Who it is (`system_role`), Boundaries (`guardrails`), Preferred language (`language_guidelines`).
  - *How it talks*: Asking questions (`detective_phase_prompt`), Giving guidance (`suggestion_phase_prompt`).
- **Journeys · N:** "Add journey", plus a search box once there are more than 5 journeys. Each row shows its key pill (J1) and name, with "N situations" underneath.
- **Shown on screen:** *Welcome and disclaimer* (`welcome_message`, `disclaimer`), "not sent to the assistant".
- **Reply layouts** (tagged "Developers"): While asking (`output_format_detective`), Full guidance (`output_format_suggestion`), Guidance with one detail missing (`output_format_partial`). These are shown in monospace with a note about the tags.

**Shared page fields:**
- Each field is a textarea with an "n / limit" counter.
- Fields that get extra text from the app show a dashed "added automatically" pill, e.g. "Journey list added here automatically".
- `detective_phase_prompt` shows the warning "Keep the words in {curly brackets}".
- A "Cleaned up: …" note marks the 3 prompts the design rewrote.

**Journey page:**
- Key pill and name, with the text "Everything specific to this journey, in one place."
- *Who it's for* (`description`).
- *Words families use* (`detection_signals`, comma-separated).
- *Questions to ask* (`detective_questions`, Asking).
- *How to guide* (`guidance`, Guiding).
- *Situations · N*, with "Add situation". Rows show key, name, `matches_when` and an "Urgent" pill.
- A green safety-net box: "None of these fit? The family is still helped…"

**Situation page:**
- Breadcrumb back to the journey, then key and name.
- An **Urgent toggle** ("If a family has two needs, urgent situations are handled first"). It maps to `priority <= 2`.
- *Use this when…* (`matches_when`).
- *Steps to follow* (`response_pattern`).

**Footer:** "N unsaved changes on this page." / "All changes published.", plus Undo last publish (or Undo cleanup), Discard, and Save and publish.

**Preview drawer:**
- Tabs: 1 Asking / 2 Guiding.
- Journey select ("Not clear yet") and Situation select ("Not known yet").
- "Sent to the assistant, top to bottom": The assistant (+ journey list) → How it talks → How to guide or Journeys to listen for → Situation steps → Reply layout → Knowledge base passages (up to 5 when asking, 15 when guiding). Fallback rows are flagged "Safety net".

**Add a journey dialog:** Name, Short code (auto `J{n}`, `^[A-Z0-9]{1,16}$`, must be unique) and Who it's for, with "Add words, questions… on the next screen."

**Prompt wording the design proposes (the `CLEAN` constant):**
- `system_role`: the journey-neutral role. It matches migration 025 except the last clause, where the design has "…resources — not to provide legal advice…" and 025 has "…resources. You do not provide legal advice…".
- `detective_phase_prompt`:
  - Keeps the `CURRENT STATUS: Exchange {exchange_count} of at least {min_exchanges}.\n{readiness_note}` line.
  - "Ask exactly ONE warm, focused question… FIRST — identify which journey… THEN — understand where they are… using that journey's questions in order."
  - STRICT RULES: one question; no resources unless `{may_suggest}` is True; never assume gender/disability/province; "Never assume the family chose the situation they describe."
  - No rights/concept signals list.
- `suggestion_phase_prompt`, in full: "Use the journey guidance and situation steps provided below to respond. If more than one situation is included, address the most urgent one first, then the other. If no single situation is clear, choose the steps that best fit what the family has said so far, and ask one question to confirm."

## 2. What exists today (verified in code)

### Storage
- **`system_messages`** holds 10 types, versioned with one active version per type. Seed history: `002_inclusion_canada_prompts.js` (role, guardrails at :86, language_guidelines at :100, output formats), `010` (disclaimer), `018` (NEVER/ALWAYS guardrails, journey-aware), `022` (output_format_partial), `024` (journey-neutral bases), `025` (role), `026` (priority passage), `027` (plain detective/suggestion).
- **`journeys`** (`key, name, description, detection_signals, sort_order, is_archived`), **`journey_clusters`** (`journey_id, key, name, matches_when, sort_order, is_archived`; `priority` was dropped in `026_drop_cluster_priority.js`) and **`journey_prompt_versions`** (`detective_questions`, `guidance` → journey; `response_pattern` → cluster). These come from `024_journey_cluster_prompts.js` (tables at roughly :660–:730). Steps were reformatted, with no word changes, in `028_plain_situation_steps.js`.
- Keys are immutable and stored in session metadata. `BOTH/UNCLEAR/UNKNOWN/NONE` are reserved (024 CHECK constraints; `journeys.py:32-38`).

### API (all present in `cdk/OpenAPI_Swagger_Definition.yaml`; note the file lives at `cdk/`, not `cdk/lambda/`)
- `GET /admin/system-messages` (:1147), `POST /admin/system-messages/{type}` (:1271), `DELETE …/{version_id}` (:1381) and `POST …/{version_id}/activate` (:1494). Handled in `adminHandler.js:206/252/423/556`. The allowed types are in `SYSTEM_MESSAGE_TYPES` (`adminHandler.js:29`), and `affects_text_generation=false` is set for `welcome_message`/`disclaimer` (:42, :370).
- `GET/POST /admin/journeys` (:1675), `GET /admin/journeys/feedback` (:1769), `PUT /admin/journeys/{id}` (:1815), `POST /admin/journeys/{id}/clusters` (:1861), `PUT /admin/clusters/{id}` (:1913), `POST /admin/journey-prompts` (:1957), `DELETE /admin/journey-prompts/{version_id}` (:2001) and `POST /admin/journey-prompts/{version_id}/activate` (:2030). Handled in `handlers/utils/journeyPrompts.js:444-575`.
- Public: `GET /system_message/{message_type}` (:2129). Only `disclaimer` and `welcome_message` are allowed (`systemMessagesHandler.js:80`).

### Admin UI (`frontend/src/pages/Admin/AdminDashboard.tsx:101` → `components/Admin/Prompts/PromptManagement.tsx`)
- `lib/promptCatalog.ts:47` `SHARED_PAGES` is the design's 4 shared pages with the same titles, subtitles, explanations and section ids. It also holds `TECH_NOTE` (:44), `STAGE_SUMMARY` (:106), which replaces the design's stage cards, `CLEANUP_NOTES` (:114) and `situationLayer` (:162), which mirrors `journeys.select_for_route`.
- `PromptManagement.tsx`:
  - Nav groups "Shared by every journey" (:230), Journeys (with search over 5 and "Show archived"), and "Shown on screen" (:310).
  - Reply layouts only appear behind a `DeveloperSwitch` (:325). In the design they are always listed.
  - Keys are never shown; they are auto-picked by `nextJourneyKey`/`nextSituationKey`, with a retry if the key is already taken.
- `PromptPanes.tsx`:
  - `SharedPagePane` (:181).
  - `JourneyPagePane` (:266): name edited inline, Who it's for (:396), Words families use as chips (:405), Questions to ask as a list editor (:414), How to guide (:424), situations list, safety-net boxes (:470/:475), feedback rating and archive.
  - `SituationPagePane` (:522): Use this when… (:623) and Steps to follow (:632). No urgent/priority control.
  - A per-field "Go back" restores the previous version (no "Undo").
- `Drawers.tsx` `PreviewDrawer` has the same 6 rows and safety-net copy as the design, showing names instead of keys. `PromptDialogs.tsx` has Add journey (Name, Who it's for; no short code) and Add situation (Name, Use this when…).

### Generation (`cdk/lambda/textGeneration/helpers/`)
- `config.load_config` caches the active `system_messages` and the journey catalog for 300 s (`config.py:330-421`). It falls back to the module constants (`config.py:62-321`) and `journeys.DEFAULT_CATALOG`.
- `logic.get_current_prompt` (`logic.py:65`) builds the prompt in two parts:
  - **Static, cached part:** `<role>` (`system_role` plus the `<supported_journeys>` list from `build_journey_list`, `journeys.py:265`), then `<guardrails>`, then `<language_guidelines>` (`logic.py:158-174`).
  - **Asking-questions turn (DETECTIVE):** code-owned `DETECTIVE_STATUS` (`config.py:176`) + admin `detective_phase_prompt` + code-owned `DETECTIVE_JOURNEY_GUIDE`/`DETECTIVE_FOCUS_RULE` + a `<journeys>` block (`build_detective_block`, `journeys.py:282`: description, signals, situation index and the focused journey's questions) + `<focus>`, then `<output_format>` = `output_format_detective`. Older prompts that still contain placeholders take the legacy fill path (`logic.py:18`, `:101`).
  - **Guidance turn (SUGGESTION/PARTIAL):** admin `suggestion_phase_prompt` + `SUGGESTION_JOURNEYS_PREFACE` (`logic.py:150`) + a `<journeys>` block (`build_suggestion_block`, `journeys.py:250`: journey `guidance` plus the routed clusters' `matches_when` and `response_pattern`, chosen by `select_for_route` at :173) + `<previous_journey_state>` + `<routing_hint>` (+ `<focus>` for partial turns), then `output_format_suggestion` or `output_format_partial`.
- `chat.py:152-175` appends the retrieved context, which is 5 passages on asking turns and 15 on guidance turns (`logic.py` constants).
- Parsing depends on the reply-layout tags:
  - `<answer>` controls streaming and the saved answer (`chat.py:371-414`).
  - `<cited_indices>` drives citations (`chat.py:418`, `citations.py`).
  - `<journey_state>` and `<detective_state>` are saved as session state (`chat.py:476-487`).
- `welcome_message`/`disclaimer` are only read by the public frontend (`HomePage.tsx:157-158`). `config.WELCOME_MESSAGE` is loaded but never used in generation.
- `routing.py:89/242`: a per-turn `urgent` flag from the router fast-tracks guidance. This replaced the admin-set priority.

### Every stored prompt field and how it's used
| Field | UI label (current) | Consumed by |
|---|---|---|
| `system_role` | The assistant › Who it is | `<role>` + journey list, every turn |
| `guardrails` | The assistant › Boundaries | `<guardrails>`, every turn (prompt text; separate from the Bedrock Guardrail `GUARDRAIL_ID`) |
| `language_guidelines` | The assistant › Preferred language | `<language_guidelines>`, every turn |
| `detective_phase_prompt` | How it talks › Asking questions | `<phase>` on asking turns |
| `suggestion_phase_prompt` | How it talks › Giving guidance | `<phase>` on guidance/partial turns |
| `output_format_detective` | Reply layouts › While asking | `<output_format>`; `<detective_state>` parsed |
| `output_format_suggestion` | Reply layouts › Full guidance | `<output_format>`; `<answer>`, `<cited_indices>`, `<journey_state>` parsed |
| `output_format_partial` | Reply layouts › Guidance with one detail missing | same as above, on partial turns |
| `welcome_message` | Welcome and disclaimer | Public chat screen only |
| `disclaimer` | Welcome and disclaimer | Public chat screen only |
| `journeys.name/description` | Journey name / Who it's for | `<supported_journeys>`, `<journeys>` headers, router enum |
| `journeys.detection_signals` | Words families use | Detective `<journeys>` "Signals" |
| `detective_questions` | Questions to ask | Detective `<journeys>` (focused journey, or all) |
| `guidance` | How to guide | Suggestion `<journeys>` |
| `journey_clusters.name/matches_when` | Situation name / Use this when… | Detective situation index; suggestion "Matches when"; router |
| `response_pattern` | Steps to follow | Suggestion `<journeys>` (routed clusters) |
| `sort_order`, `is_archived`, `key` | not shown (archive link only) | Ordering, filtering, routing/session keys |

## 3. Gap analysis (design vs current)

| Area | Design | Current | Verdict |
|---|---|---|---|
| Page/nav structure, labels, explanations | as in §1 | Same (`promptCatalog.ts:47`, `PromptManagement.tsx`) | Done |
| Stage cards with dimming | 3 cards | One-line `STAGE_SUMMARY` | Intentionally simplified further |
| Reply layouts | Always listed, "Developers" tag | Hidden behind the Developer switch | Stricter than design (good) |
| Journey/situation keys | Shown as pills; "Short code" field | Hidden and auto-generated | Intentionally removed |
| Situation Urgent toggle | `priority <= 2` | Column dropped (026); router `urgent` per turn | Intentionally removed. Re-adding needs a migration and API change. Not recommended |
| Questions to ask | Plain textarea | Numbered list editor (`QuestionListField`) | Enhanced |
| Counters | Always "n / limit" | Only at 80% or more (`showCounter`, :188) | Minor deviation |
| Undo | "Undo last publish / Undo cleanup" | Per-field "Go back" with confirm | Equivalent |
| Extras not in design | none | Archive/restore, feedback rating, "changed by" line, search, "Show archived" | Additions |
| `system_role` text | 025 text, "— not to provide…" | 025 text, ". You do not provide…" | Trivial; no action |
| `detective_phase_prompt` text | Has placeholders; no rights-signals list; neutral "chose the situation" rule | 027: no placeholders (app adds them); keeps rights-signals list; "requested the reduced schedule" rule | **Wording gap.** Keep 027's no-placeholder approach; optionally adopt the neutral rule and decide on the signals list |
| `suggestion_phase_prompt` text | 3 sentences | 027: "address the most pressing need…" + 10 CROSS-CUTTING principles (~2.1k chars) | **Main wording gap** |
| `guardrails`, `language_guidelines`, layouts, welcome, disclaimer | Not rewritten (stale seed shown) | Unchanged | No design change proposed |

**Fields the design doesn't expose:** `sort_order`, `is_archived`, `character_limit`, `affects_text_generation`, `created_by`, and (now) `key`. All of these already have backend defaults or are set by the server:
- Journey/cluster columns default in the 024 DDL.
- Character limits come from `DEFAULT_CHARACTER_LIMITS` in `adminHandler.js:46` and `journeyPrompts.js:33`.
- Keys are generated client-side and validated server-side.

No new defaults are needed.

## 4. Impact and risks of finishing the simplification

Most likely scope (content only):
- **New migration** `cdk/lambda/db_setup/migrations/031_simplified_conversation_prompts.js`. Follow the `replaceIfShipped` pattern in `027`: publish a new active version only if the live text still equals the 027 text, raise a NOTICE otherwise, keep previous versions so admins can "Go back", and include a `down`. Never edit 027.
- **Fallbacks/sync:**
  - `cdk/lambda/textGeneration/helpers/config.py` (`DETECTIVE_PHASE_PROMPT` :106, `SUGGESTION_PHASE_PROMPT` :128).
  - `frontend/src/components/Admin/defaultSystemMessages.ts` (the `addPlainVersion` block near the end).
  - `cdk/lambda/textGeneration/tests/test_prompt_sync.py`: `test_plain_prompts_have_no_machinery` currently asserts "CROSS-CUTTING RESPONSE PRINCIPLES" is present (around :168), and `test_base_prompts_keep_the_shared_pre_024_text` (:129) checks the principles survive. Both would need deliberate updates.
  - `frontend/src/lib/promptCatalog.ts` `CLEANUP_NOTES` wording, if desired.
- **No changes** to the OpenAPI spec, handlers, schema, the routing contract or WebSocket events.

Behaviour risks:
- **Dropping the 10 principles changes answers.** Some overlap elsewhere: "next step", "collaborative", "no legal advice" and "no deficit language" are in `GUARDRAILS` (`config.py:70`), and summary/sample wording/next step are in `OUTPUT_FORMAT_SUGGESTION`. Others are only in the principles: "Questions are tools (2-4 questions for the school)", "Documentation thread", "Future-focused", "Strengths-based" and "Independence as a goal". Removing them would likely make guidance replies thinner. Moving them to Boundaries or to the relevant situations' steps keeps them.
- **New instruction "If no single situation is clear… ask one question to confirm."** This fits the full-guidance layout (an optional bold question at the end), but it overlaps with the PARTIAL turn's purpose. Check that it doesn't make every fallback guidance reply end in a question.
- **"Most urgent first" vs "most pressing need first":** the wording is equivalent and there's no priority data to back "urgent". Fine either way.
- **Detective rights-signals list:** removing it relies on situation I ("Rights, concepts…") `matches_when` and the router to catch rights questions. Low risk, but test the "what is PDA" and "Article 24" openers.
- **Guardrails, grounding and citations:** unaffected as long as the reply layouts aren't touched. The `<answer>`/`<cited_indices>`/`<journey_state>`/`<detective_state>` contract lives in the layouts and `chat.py`, not in the phase prompts. The Bedrock Guardrail and the grounding thresholds (`config.py:31-51`, `intervention.py`) are independent.
- **Cache:** edits reach new messages within about 300 s (`CONFIG_TTL_SECONDS`), as the UI copy says.

Problems found along the way (outside the design's scope):
- **Fallback drift for `language_guidelines`.** Migration 002 seeds the long toolkit (:100), and as far as I could find no later migration replaces it. But `config.py:99` and `defaultSystemMessages.ts` carry a one-paragraph summary, even though `config.py` says to keep it in sync with 002. Production (DB) is probably fine; demo mode and DB-outage fallback use the short text. I did not verify this against a live DB.
- **Committed `__pycache__/*.pyc`** under `textGeneration/helpers/` (seen in `git show --stat` for d620349/6913c38). This conflicts with the repo rule against generated paths.
- **Legacy UBC copy:** none in the prompt UI or generation code. The remaining hits are `ChatInterface.tsx:33` `LEGACY_WELCOME_PROMPT`, kept intentionally to hide old history, and a comment in `config.py:395`. Don't carry forward the design file's stale seed text (the "Journey 1/Journey 2" role, the 17 stages, the "J1 or J2 / A-O" layouts).

## 5. Open questions for you

1. **Scope:** is the remaining goal only the prompt wording (the design's short "Giving guidance" and neutral "Asking questions")? The UI and schema simplification is already shipped.
2. **The 10 response principles:** drop them as the design implies, move them to Boundaries, or keep them? This is the main decision that affects behaviour.
3. **Detective prompt:** keep the rights/concept signals list? Adopt "Never assume the family chose the situation they describe" in place of the J1-specific rule?
4. **Admin-edited live text:** if an admin has already edited a prompt, should the migration skip it with a NOTICE (the 027 pattern; recommended) or overwrite it?
5. **Re-adding design features:** do you want any of the dropped ones back (Urgent toggle, visible short codes, stage cards, always-on counters)? Each one, except counters and cards, reverses an earlier simplification. The Urgent toggle would also need a migration and API change.
6. **Fallback drift:** should the `language_guidelines` fallback be fixed in the same change?

## Recommendation

Treat the design as implemented. If you want the remaining wording changes, do them as one content-only change:
- Add a new migration `031` that publishes the simplified "Asking questions" and "Giving guidance" text, only where the 027 text is still live.
- Keep the unique principles somewhere (Boundaries or situation steps) rather than deleting them.
- Update the `config.py` and `defaultSystemMessages.ts` fallbacks and `test_prompt_sync.py`.
- Verify with `python -m unittest` in `cdk/lambda/textGeneration` (`tests/test_prompt_sync.py`, `tests/test_journeys.py`), `npm test` (vitest `promptCatalog.test.ts`) and `npm run build` in `frontend/`, and the Jest tests under `cdk/lambda/db_setup/tests`.

**Verified vs inferred:** all code, migration, API and UI statements above come from reading the files, the git history and the decoded design bundle. Not verified: actual DB contents (whether admins edited prompts, and the live `language_guidelines` text), model behaviour after a wording change, and whether the test suites currently pass (none were run).
