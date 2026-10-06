# Hiding guidelines from public "More resources"

## Summary

Yes. Guidelines are already stored and retrieved separately from resources. They only show up for users because of one deliberate projection step. In guideline mode, `helpers/chat.py` turns every cited guide section into a public card titled `"Family guide: <situation label>"` with `source_type: "guideline"` (`_public_guideline_source`). That card is streamed in the WebSocket `complete` event, saved to `chat_messages.sources`, and returned by the public chat-history API. `AIChatMessage.tsx` then explicitly lists `type === "guideline"` under "More resources".

Recommended fix (Option A): filter on the server side.
- Drop guideline citations from the public source list in `chat.py`.
- Filter `source_type === "guideline"` out of the public history projection in `handlers/utils/publicSources.js`. This also cleans up rows that were saved earlier, so no data migration is needed.
- Strip `guide_state` (which holds the guide's section label) from the session metadata returned by `GET /chat_sessions/user/{user_id}`.
- Tighten the guideline prompt so the model never names guides, situation labels or file names. Stop putting guide file names in the prompt outline at all.
- Keep guide sections in the model context and in the grounding verifier, so answers stay grounded.

Standard mode never touches guidelines. Its retrieval excludes them through `retrieval_hidden`. Only `PROMPT_MODE == "guideline"` is affected.

## 1. What a "guideline" is today

A guideline is a separate, explicit content type. It came in with migration `031_guideline_mode.js`:
- `guideline_config` holds a single row. `prompt_mode` is `'standard'` or `'guideline'` and selects the pipeline (`config.PROMPT_MODE`).
- `guideline_documents` (uploaded file, `file_name`, `s3_key`, status) and `guideline_sections` (`auto_label`, `label_override`, `heading_path`, `section_key`).
- Chunks live in the shared `sources`/`chunks` tables, under one hidden source per document:
  - `url = guideline://doc/{id}`
  - `metadata = {kb_role: 'guideline', retrieval_hidden: 'true', guideline_document_id}`

  These are written by `upsert_guideline_source` in `cdk/lambda/knowledgeBase/helpers/guideline_document.py`.
- Admin UI: Admin → "Guides" tab (`frontend/src/components/Admin/Guideline/GuidelineMode.tsx`, `hooks/useGuideline.ts`, `lib/guideline.ts`). It calls the `/admin/guideline/*` endpoints (`knowledgeBase/helpers/guideline_admin.py`).

So no new `source_type`/visibility column is needed. `kb_role = 'guideline'` on the source and `source_type = "guideline"` on the retrieval dict already mark guidelines unambiguously.

Unrelated "guidelines": `language_guidelines` in `system_messages` is a prompt text type, not a document, and it never appears as a source. The prompts-simplification report covers only that and journeys. It has nothing about guide documents.

## 2. Source path from retrieval to UI (guideline mode)

1. **Retrieval.**
   - `helpers/guideline_retrieval.py` `retrieve_guideline_sections` returns dicts with `type: "GUIDELINE"`, `source_type: "guideline"`, `title: <section label>`, `url: ""`, full `content`, and `metadata.{document_id, section_key, heading_path, file_name}`.
   - Library resources come from `helpers/retrieval.py` `retrieve_from_pgvector`. It excludes guides with `COALESCE(s.metadata->>'retrieval_hidden','false') <> 'true'`, around line 281.
2. **Combining.** `chat.py` `_prepare_guideline_conversation` builds `sources = sections + resources` with shared numbering `[1..n]`, `[n+1..]` for `<cited_indices>`.
3. **Prompt.**
   - `helpers/guideline_prompt.py`: `format_sections` writes `[i] Situation: <label>` plus `Heading: <heading_path>`.
   - `build_outline` writes `Guide: <file_name>` plus every situation label into the cached static prompt.
   - `GUIDELINE_INSTRUCTIONS` already says never to mention "sections", "documents" or "the guide". It does **not** forbid naming situation labels or file names.
4. **Public projection (the leak).**
   - `chat.py` `get_response` builds `used_sources = select_cited_sources(...)`.
   - `public_sources` maps guideline sources through `_public_guideline_source`, which produces title `"Family guide: <label>"` with content, url and metadata removed but `source_type: "guideline"` kept.
   - `public_sources` is:
     - saved by `_save_ai_response` into `chat_messages.sources`
     - returned as `sources_used`
     - sent by `main.py` in the WebSocket `complete` event (`'sources': response_body['sources']`)
5. **Grounding.** `assess_response(sources=used_sources)` gets the full, unprojected sources. The warning text comes from fixed strings in `intervention._warning_for_label`, so guide names never appear in it.
6. **History API.**
   - `GET /user/{user_id}/chat_sessions/{chat_session_id}/chat_history` (`handlers/userHandler.js`) maps rows through `toPublicMessage` → `toPublicSources` (`handlers/utils/publicSources.js`).
   - That function sanitizes fields but does **not** drop guideline entries, so stored "Family guide: …" cards come back to the user.
7. **Session list.**
   - `GET /chat_sessions/user/{user_id}` (`handlers/chatSessionHandler.js` ~line 111) returns raw `chat_sessions.metadata`.
   - In guideline mode that includes `guide_state = {document_id, section_key, label}`, saved by `crud.save_guide_state`.
   - The UI doesn't render it, but `HomePage.tsx:71` stores it client-side, and anyone can read it in the network response.
8. **Frontend.**
   - `AIChatMessage.tsx` `isResourceSource` returns true for `type === "guideline"`.
   - The card shows the type label "GUIDELINE" and the title "Family guide: …" under "More resources".
   - `isSuggestionPhase` relies on `phase === "SUGGESTION"` (always sent in guideline mode), so removing guideline sources won't change the card layout.
9. **Admin.** `GET /admin/chat_sessions/{sessionId}/messages` (`adminHandler.js` ~line 1140) returns raw stored `sources`. This is admin-only (Cognito), so admins can legitimately see guideline citations.
10. **Tests that encode today's behaviour.** `textGeneration/tests/test_chat_guideline_mode.py`:
    - `test_cited_resources_get_normal_cards` expects `["Family guide: Child sent home early", "Keeping a school log"]`.
    - `test_citation_has_no_preview_or_link` expects the guideline card to be present.

### Every place guideline names can reach a public user

| Place | Today | Leaks |
|---|---|---|
| WebSocket `complete.sources` | Contains the "Family guide: <label>" card | Yes |
| `chat_messages.sources` → public history API | Stored the same way; `toPublicSources` doesn't drop it | Yes |
| `chat_sessions.metadata.guide_state.label` → `GET /chat_sessions/user/{id}` | Raw metadata returned | Yes (API only, not rendered) |
| Answer text (`chunk` events, saved content, auto session title) | Model may say the situation label or file name; the outline gives it file names | Possible |
| Inline markdown links | Guides have `url: ""` and `guideline://` is never given to the model; `strip_internal_links` removes non-http links anyway | No |
| Grounding warning | Fixed strings | No |
| Logs | Counts/booleans only | No |

## 3. Design options

### Option A (recommended): server-side public filter on the existing `source_type`

- In `chat.py`, split the cited sources into `public_sources`, which are non-guideline only and get streamed and returned, and `stored_sources`.
- Choose one of two ways to store:
  - **A1 (simplest, safest):** persist only `public_sources`. Admins still see which guide section drove the turn through `chat_sessions.metadata.guide_state`.
  - **A2:** persist `public_sources` plus the guideline citations, keeping `source_type: "guideline"` and storing the label without the "Family guide:" prefix, so admin message views keep them. Every public path must then filter them.

  Recommendation: A2 with a filter in `toPublicSources`. Because that filter is needed anyway for rows already saved, A2 adds no extra public-facing risk, and admins keep the audit trail.
- In `publicSources.js` `toPublicSources`, drop any entry whose `source_type` or `type` (case-insensitive) is `guideline`. This is the backfill: old rows are cleaned up on read. Nothing is rewritten, so no migration is needed.
- In `chatSessionHandler.js` `GET /chat_sessions/user/{user_id}`, return `metadata - 'guide_state'` (SQL `metadata - 'guide_state' AS metadata`) or remove the key in JS. No API shape change.
- Prompt hardening in `guideline_prompt.py`:
  - Drop `Guide: <file_name>` lines from `build_outline` (group by a neutral "Guide 1/2" or no header).
  - Add a strict rule: never name, quote or title-case the situation names, headings, guide titles or file names, and never say "family guide". Describe the situation in the family's own words.
  - Remove `Heading:` from `format_sections` only if testing shows the model echoes it. It does help selection.
- Optional deterministic post-filter: in `chat.py`, before saving, remove occurrences of each `guideline_documents.file_name` (and its stem) from `final_answer_text`. Situation labels are natural phrases ("Child sent home early"), so blind stripping would damage answers. Rely on the prompt for those.
- Frontend: remove `type === "guideline"` from `isResourceSource` as defense in depth only. The server filter is the actual control.

Pros:
- No schema migration and no REST/WebSocket contract change; `sources` stays an array of the same shape.
- Grounding is unchanged (`used_sources`).
- Fixes old history too.

Cons: answer-text leakage can only be reduced through the prompt, not fully guaranteed.

### Option B: guidelines never enter the citation list

- Number guide sections differently (e.g. `G1..Gn`), outside `<cited_indices>`.
- Keep `<guide_state>` as the only pointer to a section, and let `<cited_indices>` cover resources only.

Pros: structurally impossible for a guide to become a citation.

Cons:
- Changes the output contract, `parse_guide_state`, `select_cited_sources` numbering, the grounding input (it would need to add the chosen section explicitly) and several tests.
- Old history still needs the `toPublicSources` filter.
- More churn for the same user-visible result.

### Option C: new visibility column (`data_sources.visibility` / `sources.visibility = 'internal'`), propagated to chunks and filtered generically

Needs migration `032_source_visibility.js` (add column with default `'public'`, backfill `UPDATE sources SET visibility='internal' WHERE metadata->>'kb_role'='guideline'`), plus changes to the retrieval SELECTs, `guideline_document.py`, the admin data-source UI toggle and OpenAPI.

Pros: generalises to marking any library source as internal.

Cons:
- Overkill. Guides already have their own upload pipeline and an unambiguous marker, and nothing asks for internal library resources.
- Still needs the same public filters as Option A.

Only worth doing if admins later want to hide ordinary data sources.

**Recommendation: Option A (variant A2).** It is the smallest server-side change, preserves all contracts and the admin/public split, and backfills on read.

## 4. Files and functions to change (Option A)

1. `cdk/lambda/textGeneration/helpers/chat.py`
   - `get_response`: build `public_sources = [to_public_source(s) for s in used_sources if s.get("source_type") != GUIDELINE_SOURCE_TYPE]` for the stream/return.
   - Build `stored_sources = public_sources + [internal guideline entries]` for `_save_ai_response`.
   - Replace or remove `_public_guideline_source`. For the internal entry: keep `source_type: "guideline"` and the plain label, no content/url/metadata.
   - Keep `assess_response(sources=used_sources)` unchanged.
   - Optional: scrub guide file names from `final_answer_text`.
2. `cdk/lambda/handlers/utils/publicSources.js`
   - `toPublicSources`: filter out entries with `source_type`/`type` equal to `guideline` (case-insensitive) before mapping.
   - Update the header comment.
3. `cdk/lambda/handlers/chatSessionHandler.js`
   - `GET /chat_sessions/user/{user_id}`: exclude `guide_state` from the returned `metadata`.
   - Check whether `POST`/`PUT /chat_sessions` `RETURNING metadata` can include it; PUT on an existing session can, so apply the same projection there.
4. `cdk/lambda/textGeneration/helpers/guideline_prompt.py`
   - `build_outline`: stop emitting `file_name`.
   - `GUIDELINE_INSTRUCTIONS`: add a rule never to name situations, headings, guide titles or file names.
   - Leave `GUIDELINE_OUTPUT_FORMAT` alone apart from the citation note; the `<cited_indices>` contract stays the same.
5. `frontend/src/components/ChatInterface/AIChatMessage.tsx`
   - `isResourceSource`: drop `type === "guideline"` (defense in depth) and update the comment.
6. Tests:
   - Update `textGeneration/tests/test_chat_guideline_mode.py`: the guideline card is absent from `sources_used` and from what is streamed, and is still present in the `insert_message` sources arg (A2). Grounding still receives the full section.
   - Update `tests/test_guideline_prompt.py` if it asserts on the outline's file name.
   - There are no Jest tests for `publicSources.js` today. Add a small one (e.g. `cdk/lambda/handlers/utils/publicSources.test.js`) only if a JS test runner is configured for `cdk/lambda/handlers`; otherwise check it manually.

No migration, CDK or OpenAPI change is required: response shapes are unchanged and only array contents and metadata keys shrink. The admin Guides UI needs no changes, since guide documents are already marked as guidelines because of where they're uploaded.

Verification:
- `python -m unittest discover -s tests -v` in `cdk/lambda/textGeneration`
- `npm run build` and `npm run lint` in `frontend/`
- `npm run build` and `npx cdk synth` in `cdk/` if desired

### Residual risk

The LLM can still say a situation name in its own words, because the guide content shapes the answer. That is acceptable and unavoidable: the content is meant to be used. What the fix guarantees is that no guide titles, file names or "Family guide" cards reach users through structured payloads, history or metadata. Plain-text mentions are reduced through the prompt, plus an optional file-name scrub.

Not verified: live DB contents (how many stored messages hold guideline cards) and whether the tests pass today. No tests were run.
