# How Knowledge Compass evaluations work

**Audience:** project managers and technical stakeholders
**Last updated:** October 2026
**Operator runbook:** [`evals/README.md`](../evals/README.md)

This document explains what the evaluation harness checks, how a run is carried out, and how to read the results. The first half is for planning, review, and release decisions. The second half is for people who run the harness or change how scoring works.

---

## 1. What this is for

Knowledge Compass is a chat assistant that helps families in Canada navigate inclusive education. The product is specified as Inclusion Canada user stories: a parent’s situation, the behaviour the assistant should show, a reference conversation, and the facts the answer should stay inside.

The evaluation harness checks that behaviour against the **live public chat API**. It creates real anonymous sessions, sends real messages, and records what the assistant actually does. It then scores those conversations.

A run answers four questions:

1. Did the assistant recognise the family’s situation (the right journey and situation)?
2. Did the conversation follow the story the authors wrote (questions first, then useful guidance)?
3. Did the guidance meet the story’s acceptance criteria?
4. Did the replies stay inside the product rules (plain language, collaborative, strengths-based, and free of legal advice, blame, and speculation)?

Scores are numbers for comparison across runs. There is no automatic pass or fail threshold. A single score moves a little from run to run because a language model is doing part of the grading. Decisions should use trends, the written judge notes, and the transcripts.

---

## 2. What is being tested

There are **71 scenarios**, one YAML file per user story, under `evals/scenarios/`. Each file was drafted from the user-story Markdown and then reviewed. Personas and messages are synthetic. Real family details do not belong in a scenario.

| Journey | What the family is dealing with | Features | Stories |
|---|---|---|---|
| Journey 1 | A child is being sent home or put on a reduced schedule without the family’s choice | Feature 1: what to do next (18). Feature 2: plain-language explanations (12). Feature 3: rights and advocacy (15) | 45 |
| Journey 2 | Planning courses, transitions, and supports | Feature 1: keeping options open (11). Feature 3: transition planning (8). Feature 4: support quality (7) | 26 |

Story ids look like `111`, `11A`, `211`. The same ids are used in [`Docs/user-stories/`](user-stories/README.md).

Each scenario carries:

- the story text and a short situation summary
- the parent’s opening message
- a synthetic persona and hidden facts the simulated parent may reveal when asked
- the reference conversation, step by step
- acceptance criteria and testing checks
- variant openings (the same situation said a different way) and negative cases (messages that should **not** be treated as this journey)
- which chat modes to run (`standard`, `guideline`, or both)

`evals/scenarios/label_map.yaml` maps each story onto the live catalog: journey key (`J1` or `J2`) and the situation clusters the router is expected to pick.

Stories the chat cannot perform (for example, tracking actions over time, or producing a downloadable checklist) can be marked `testable: false` and are left out of a scoring run. At the time of writing, every scenario is marked testable and reviewed.

### The two chat modes

| Mode | What the family experiences | What the eval checks |
|---|---|---|
| **Standard** | The assistant asks a few clarifying questions, then gives guidance. | Routing, detective behaviour, and the quality of the guidance. |
| **Guideline** | Answers come from uploaded family guides. The assistant may ask one clarifying question, then answer with citations. | The same quality scores. Routing is skipped, because guideline mode does not route. |

A run can compare the two modes on the same stories. The comparison is per session. It does not change the global prompt-mode setting that real families use.

---

## 3. How a run works

```
User stories                Scenarios                 Live chat API
(reviewed Markdown)  --->   (reviewed YAML)    --->   anonymous session
                                                        |
                            Routing probes              one message, then stop
                            Full journeys               simulated parent, several turns
                                                        |
                            Scores and transcripts  <-- judge + optional Bedrock job
```

### Step 1. Scenarios are reviewed before anyone is scored

A draft can be generated from the user-story documents. A reviewer then checks that the persona is synthetic, the messages sound like a parent, and the expected situation matches the live journey catalog. A scenario is eligible for scoring only after `reviewed: true` is set on the scenario and on the label map, and `python -m evals validate --for-scoring` reports no problems.

### Step 2. A smoke test confirms the environment

One anonymous user, one tagged session, one message. The smoke test prints the phase and the routing result, checks that the session is excluded from admin analytics, and deletes the session. This is the gate before a larger run.

### Step 3. Routing probes

For each selected story the harness sends **one message and stops**:

- the story’s opening message
- each variant (“my daughter only attends in the mornings…”)
- each negative case (a message that belongs to a different situation)

It reads back which journey and situation the router chose. These probes answer “did we recognise the situation?” without paying for a full conversation.

### Step 4. Full journeys

For each selected story and mode, the harness opens a fresh anonymous session and plays the conversation out:

1. The opening message is sent.
2. A separate, smaller model plays the synthetic parent. It answers the assistant’s questions using only the scenario’s hidden facts, and it does not dump every fact on the first turn.
3. The journey stops at the first **guidance** turn. In standard mode that is a suggestion. In guideline mode that is a suggestion that cites sources. It also stops at the turn limit (default 8), on an error, or if the daily message limit is hit.

A typical journey is about five turns.

### Step 5. Scoring

Two graders can run. The direct judge always runs unless it is turned off. The Amazon Bedrock evaluation job is optional.

**Direct judge.** A stronger model (Claude Opus by default) reads the transcript and the story. The model that wrote the assistant’s replies does not grade them. Temperature is 0. The judge must fill in a fixed form: one verdict per reference step, one verdict per acceptance criterion, a detective rating, a pass or fail on each product rule, and a grounding rating. Those verdicts are turned into scores from 0 to 1.

**Bedrock Evaluations (optional).** The same transcripts are sent to Amazon Bedrock’s evaluation service, one job per mode. Bedrock scores built-in qualities (correctness, completeness, helpfulness, coherence, faithfulness, harmfulness, stereotyping) and custom metrics that reuse the product rules and acceptance criteria. Jobs of this size can take several hours. The harness will not start a second job for a run that already has one, unless someone explicitly asks for a new set.

### Step 6. The report and the conversations

Each run is a folder, `evals/results/<run_id>/`:

| File | What it is |
|---|---|
| `report.md` | The summary people read in a review |
| `report.json` | The same numbers, for comparison across runs |
| `journeys/` | Full transcripts |
| `probes/` | Routing results |
| `judge/` | Scores plus the judge’s notes |
| `bedrock/` | Bedrock job status and metrics, when that option was used |
| `run.json` | When it ran, which stories, which models, cleanup status |

Conversations can also be exported as one Markdown file or one Excel workbook (About, Summary, Turns, Judge notes, Probes) for people who want to read the chats rather than the averages.

---

## 4. How to read a report

Open `report.md` for the run. Read it in this order.

### Header

Stories included, modes, users created, sessions created and deleted. If sessions could not be deleted, they are listed. They stay tagged with the run id, so they stay out of family analytics. If an admin token was available, the report also records the global prompt mode before and after the run. Those two values should match: the eval changes mode only inside its own sessions.

### Routing

Three rows, each with a count, a journey accuracy, and a situation accuracy:

| Row | Meaning |
|---|---|
| Probes | Opening messages and variants. This is the cleanest read of “did we recognise the situation from the first message?” |
| Journeys, first turn | The same question on the opening turn of a full conversation. |
| Journeys, final turn | Whether the route was still right by the time guidance was given. |

Accuracy is a fraction from 0 to 1. Journey accuracy means the router picked `J1` or `J2` as the label map expects. Situation accuracy means the primary situation is one of the clusters listed for that story. A separate secondary-match rate covers cases where the expected cluster showed up as the second choice.

**Negative cases** are reported as a false-positive count and rate. A false positive means a message that should have stayed out of this journey was routed into it.

A confusion list shows expected journey to the journey that was actually chosen. That list is the practical input for “which situations are being mixed up?”

Guideline-mode sessions are omitted from routing. They do not choose a journey.

### Judge scores

One row per mode, then one row per story. All scores are 0 to 1.

| Column | What a higher number means |
|---|---|
| Reached guidance | How many stories got as far as a guidance turn. |
| Turns to guidance | How many parent messages it took. Lower is a shorter path, and it is still a quality question: too few turns can mean the assistant advised before it understood the situation. |
| Flow | How much of the reference conversation showed up, in the first reply or later, up to the guidance turn. |
| Flow (first reply) | How much of that reference showed up in the very first reply. Useful when the story expects an immediate explanation. |
| Criteria | Share of acceptance criteria and testing checks judged met. Partial counts as half. Items marked not applicable are left out of the average. |
| Detective | Quality of the clarifying questions before guidance: relevant, short, not repeated, and not jumping ahead into advice. |
| Rules | Share of product rules marked pass. The per-story row names any rule that failed. |
| Grounding | How well the guidance stays inside the source previews the chat actually showed. |

**Product rules**, judged on every assistant reply:

| Rule | The assistant should |
|---|---|
| No legal advice | Give general information about rights and processes. It should not tell a parent the school broke the law or predict what a court would decide. |
| No blame | Describe actions and options. It should not assign fault to the school, the staff, the parent, or the child. |
| No speculation | Stay with what the parent said. It should not invent a diagnosis, a motive, or a certainty. |
| No deficit language | Keep a strengths-based, inclusive framing. |
| Family-friendly | Use plain, warm language and acknowledge the situation. |
| Collaborative | Encourage working with the school and offer a clear next step. |

### Guideline minus standard

When a story was run in both modes, the report shows guideline minus standard for each score. A positive number means guideline scored higher on that story. The mean delta is the average of those differences. Read it next to the per-story table. One mode can win on grounding and lose on detective behaviour.

### Bedrock metrics

Present only when a Bedrock evaluation job was collected. Each metric is a mean and a count. Built-in harmfulness and stereotyping are safety checks alongside the product rules. Faithfulness uses the short source previews returned to the chat, so treat it as approximate.

### What to do with a weak story

1. Open the transcript for that story and mode.
2. Read the judge notes for the failed steps, criteria, or rules.
3. Decide whether the gap is routing (wrong journey or situation), conversation design (questions or tone), or content (the guidance is missing a fact the story requires).
4. Compare with the previous run of the same story before treating a small movement as a regression. Judge scores vary between runs.

---

## 5. Planning a run

### Suggested sequence

| When | What to run | Why |
|---|---|---|
| After a scenario or label-map edit | `validate --for-scoring` | Confirms the catalog is complete enough to score. |
| Before any live traffic | Smoke test | Confirms credentials, signing, analytics exclusion, and cleanup. |
| During development | A handful of stories, often both modes | Fast feedback. The default limit is 3 stories. |
| Before a release review | The stories touched by the change, plus a standing sample from each feature | Enough coverage to see routing and quality movement. |
| Periodic full pass | All 71 stories | The baseline for trend comparison. Budget time and model cost before starting it. |

Start with a small batch. A full pass of all 71 stories in both modes is on the order of 140 journeys, about 160 probes, about 300 anonymous users, and more than 1,000 chat turns. Each turn also spends model calls inside the product (routing, answer, grounding check, and an embedding). On top of that, each journey spends a few simulator calls and one judge call.

### What a release review should look at

- Routing accuracy on probes, and which journeys are confused with each other.
- False-positive rate on negative cases.
- Share of stories that reached guidance, and turns to get there.
- Product-rule failures, by rule name. These are the items most likely to matter to families and to Inclusion Canada.
- Stories whose criteria or flow score dropped against the previous comparable run.
- Grounding, read together with the cited sources in the transcript.
- Confirmation that eval sessions were deleted, or that any leftovers are tagged and listed.

### Load and privacy

The harness runs **one conversation at a time**, with a pause between turns and between users. It shares the same API and the same low Lambda concurrency as real families, and the web application firewall caps unauthenticated requests per IP. A full run belongs in a window when family traffic is low.

Eval sessions are marked at creation and are excluded from admin analytics and journey feedback. They are deleted after the result file is saved. The anonymous users created for the run can still appear in the admin user list. The harness does not submit feedback.

Personas are synthetic. The simulator is instructed to avoid real names, schools, phone numbers, and addresses.

### What this eval does not claim

- It does not replace a read-through by someone who knows the user stories. The transcripts exist so that read-through can happen.
- It does not test the admin console, document ingestion, or the embedding pipeline. Those have their own checks.
- It does not set a contractual pass mark. Thresholds, if a release needs them, are a product decision applied to these reports.

---

## 6. Technical reference

Commands are run from the repository root with the evals virtualenv. Exact flags, environment variables, and AWS permissions are in [`evals/README.md`](../evals/README.md).

```powershell
py -m venv evals/.venv
evals/.venv/Scripts/python -m pip install -r evals/requirements.txt
evals/.venv/Scripts/python -m evals validate --for-scoring
evals/.venv/Scripts/python -m evals --env-file evals/.env smoke --yes
evals/.venv/Scripts/python -m evals --env-file evals/.env run --stories 111,114,211 --modes standard,guideline --yes
```

Unit tests live in `evals/tests/` and do not call the network.

### Components

| Piece | Role |
|---|---|
| `evals/schema.py` | Scenario and label-map shape, loading, and the checks `validate` runs. |
| `evals/extract.py` | User-story Markdown to draft YAML. Re-runs keep reviewed files unless overwrite is requested. |
| `evals/harness/client.py` | Public REST and WebSocket client. Creates an anonymous user, opens a session, sends a turn, reads routing metadata, deletes the session. |
| `evals/harness/signing.py` | Builds the HMAC tag from the signing secret. |
| `evals/harness/simulator.py` | Parent role-play. Default model is Claude Haiku. |
| `evals/harness/runner.py` | Sequential probes and journeys. Concurrency is 1. |
| `evals/judge/routing_metrics.py` | Journey accuracy, situation accuracy, false positives, confusion tables. |
| `evals/judge/judge.py` | One forced-tool Bedrock call per transcript. Default model is Claude Opus. |
| `evals/judge/bedrock_eval.py` | Optional Bedrock RAG evaluation, bring-your-own responses, one job per mode. |
| `evals/report.py` | `report.md` and `report.json`. |
| `evals/transcripts.py` | Combined Markdown or Excel export. |

### How a session is marked as an eval

`POST /chat_sessions` accepts an optional top-level `eval` object. The harness signs it with a key held in Secrets Manager (`KC/eval/signing-secret` by default):

```text
eval = { run_id, mode, exp, sig }
sig  = hex(HMAC-SHA256(signingKey, "{userId}.{run_id}.{mode}.{exp}"))
```

The API checks the signature with a timing-safe compare, binds it to the caller’s user id, checks the run id and mode, and rejects an expiry more than 24 hours ahead. A valid tag writes two server-only columns added by migration 035: `eval_run_id` and `prompt_mode_override`. Anything else creates an ordinary session, and the response does not say why. The tag and the key are not logged.

Text generation reads the override through `config.resolve_prompt_mode` and leaves the global prompt mode unchanged. Admin analytics and journey feedback skip sessions that have `eval_run_id` set.

The signing secret, the results bucket, and the Bedrock evaluation role are created by the Eval stack, and only when the API is deployed with eval support enabled. Deployed without that support, tags fail closed and every session is a normal one. Malformed tags are rejected before any Secrets Manager call.

### Routing math

Taken from `metadata.routing.route` after the turn:

- **Journey hit:** `route.journey` equals the story’s `journey_key`.
- **Situation hit:** `route.situation` is in the story’s expected clusters.
- **Secondary match:** the primary situation missed and `secondary_situation` is in those clusters. Counted separately, and not inside situation accuracy.
- **False positive:** a negative-case probe whose journey equals the story’s own journey key.

Probes with an error or with no routing are listed as failures and left out of the rates.

### Judge math

| Score | Formula |
|---|---|
| Reference flow | Mean of step verdicts: present in the first reply = 1, present later = 0.75, partial = 0.5, absent = 0. |
| Flow, first reply | Share of steps marked present in the first reply. |
| Acceptance criteria | Mean of met = 1, partial = 0.5, not met = 0. `not_applicable` is excluded. Expectations are the acceptance criteria, the testing checks, and, when present, the guiding question. |
| Detective | The 1–5 rating divided by 5. The rubric is `evals/judge/rubrics/detective.md`. |
| Product rules | Passes divided by rules that were marked pass or fail. `unclear` is excluded. Failures are listed by rule key. |
| Grounding | The 1–5 rating divided by 5, judged against the cited source previews (trimmed). |

The judge also records whether guidance was reached and the turn index of that guidance.

### Bedrock evaluation job

One JSONL record per journey. The prompt is the conversation up to the guidance turn, the reference response is the expectations plus the reference flow, and the model output is the guidance reply plus the public source previews. Because a job accepts one RAG source, standard and guideline are separate jobs.

Built-in metrics: Correctness, Completeness, Helpfulness, LogicalCoherence, Faithfulness, Harmfulness, Stereotyping.

Custom metrics: one per product rule (`kc-no-legal-advice`, and the rest) plus `kc-acceptance-criteria`, on a 0 / 0.5 / 1 scale. The evaluator model is the same judge model. `bedrock-eval --collect` writes finished metrics back into the report. A waiter gives up after four hours per job; collection can be run later.

### Models and regions

| Caller | Default model | Default region |
|---|---|---|
| Parent simulator | Claude Haiku 5.5 | `us-west-2` (`KC_BEDROCK_REGION`) |
| Direct judge and Bedrock evaluator | Claude Opus 4.6 | same |
| Scenario extraction | Claude Haiku 5.5 | same |

The chat API itself uses whatever models the deployed stack is configured with. The harness uses the caller’s own AWS credentials. It does not assume the application’s IAM roles.

### Operational limits the harness already respects

- One in flight conversation.
- Default pauses: 2 seconds between turns, 5 seconds between users.
- Fresh anonymous user per probe and per journey, so a long run does not trip the per-user daily message cap (45 messages and 10,000 characters).
- Backoff on HTTP 429 and on web-application-firewall blocks.
- The harness never sends feedback and never sets the intro-message flag. The server ignores that flag, and the guardrail still runs.

---

## 7. Related documents

- [`evals/README.md`](../evals/README.md) — setup, environment variables, commands, and production cautions.
- [`Docs/user-stories/README.md`](user-stories/README.md) — the stories these scenarios come from.
- [`evals/judge/rubrics/`](../evals/judge/rubrics/) — the judge’s instructions, detective rubric, and product rules.
