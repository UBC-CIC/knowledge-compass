# Evaluation harness

Automated tests of Knowledge Compass journeys and situations against the live
public chat API. It:

- sends **routing probes**: one-message conversations built from each user story's
  opening message, testing-consideration variants and negative cases. It checks which
  journey and situation the router picks.
- runs **journeys**: multi-turn conversations in which a Bedrock "parent simulator"
  answers the detective questions until the assistant gives guidance.
- **judges** each journey with a separate model (Claude Opus by default). The judge scores
  the reference flow, acceptance criteria, detective behaviour, product rules and grounding.
- optionally runs **Amazon Bedrock Evaluations** jobs (RAG, bring-your-own-responses)
  on the same transcripts.
- compares **standard vs guideline mode** per session, without touching the global setting.

Scores are report-only. LLM judge scores vary a little between runs, so compare
trends across runs rather than single numbers.

## Layout

```
evals/
  scenarios/            committed: one YAML per user story + label_map.yaml
  harness/              API client, signed eval tags, parent simulator, runner
  judge/                routing metrics, LLM judge (+ rubrics/), Bedrock Evaluations
  extract.py            user-story Markdown -> draft scenarios
  report.py             report.md / report.json per run
  tests/                unit tests (no network); fixtures/scenarios/ has a synthetic example
  results/              gitignored run output (transcripts, judge rationales)
```

## Setup

```powershell
py -m venv evals/.venv
evals/.venv/Scripts/python -m pip install -r evals/requirements.txt
evals/.venv/Scripts/python -m unittest discover -s evals/tests -t .
```

Run commands from the repository root as `evals/.venv/Scripts/python -m evals <command>`.
Settings come from environment variables. `--env-file evals/.env` loads them from a file,
and `.env` files are already gitignored.

| Variable | Needed for | Default |
|---|---|---|
| `KC_API_URL` | run, smoke | – (REST base URL including the stage, e.g. `https://…/prod`) |
| `KC_WS_URL` | run, smoke | – (`wss://…` WebSocket URL including the stage) |
| `KC_AWS_REGION` | signing secret | `ca-central-1` |
| `KC_EVAL_SECRET_NAME` | signing secret | `KC/eval/signing-secret` |
| `KC_BEDROCK_REGION` | simulator, judge, extract | `us-west-2` |
| `KC_SIMULATOR_MODEL` | journeys | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `KC_JUDGE_MODEL` | judge, Bedrock eval | `us.anthropic.claude-opus-4-6-v1` |
| `KC_EXTRACT_MODEL` | extract | `us.anthropic.claude-sonnet-4-6` |
| `KC_EVAL_BUCKET`, `KC_EVAL_ROLE_ARN`, `KC_EVAL_JOB_REGION` | Bedrock eval | EvalStack outputs |
| `KC_ADMIN_ID_TOKEN` | optional checks | – (Cognito admin ID token; enables the analytics/global-mode checks and `--catalog admin`) |
| `KC_TURN_DELAY_SECONDS`, `KC_USER_DELAY_SECONDS` | pacing | `2`, `5` |
| `KC_RESPONSE_TIMEOUT_SECONDS`, `KC_MAX_TURNS` | journeys | `120`, `8` |

### AWS permissions for the person running it

Use your own credentials (`AWS_PROFILE`). The harness never uses the app's roles.

- `secretsmanager:GetSecretValue` on the eval signing secret.
- `bedrock:InvokeModel` on the simulator, judge and extract models (and their inference profiles).
- Bedrock eval only:
  - `bedrock:CreateEvaluationJob`
  - `bedrock:GetEvaluationJob`
  - `iam:PassRole` on the EvalStack evaluation role
  - `s3:PutObject` on `input/*` and `s3:GetObject` on `output/*`
  - `s3:ListBucket` on the results bucket

## Infrastructure (one-time)

Backend changes (already in source):

- **Migration 035** adds two server-only columns to `chat_sessions`: `eval_run_id` and `prompt_mode_override`.
- **`POST /chat_sessions`** accepts an optional top-level `eval` tag. Only a correctly signed tag sets those columns.
- **textGeneration** resolves the prompt mode per session, in `config.resolve_prompt_mode`.
- **Admin analytics and journey feedback** exclude sessions that have `eval_run_id` set.

Deploy in this order, after reviewing `cdk diff`:

1. `KC-DBFlow` (runs migration 035)
2. `KC-Api` **with `-c enableEval=true`**
3. `KC-Eval` with `-c enableEval=true`

The API only gets the `EVAL_SIGNING_SECRET_NAME` variable and the read grant on the
secret when `enableEval=true`, so pass the flag on every later `KC-Api` deploy too.
Deploying `KC-Api` without it switches eval tags off again (sessions are created as
normal ones).

The EvalStack creates:

- the signing secret
- a private results bucket with 30-day expiry
- a Bedrock evaluation service role, scoped to the judge model

The bucket and role go in the stack Region. To use a different Region for evaluation jobs, pass
`-c evalJobRegion=us-west-2`, which adds a `KC-EvalJobs` stack there. Choose the judge models with
`-c evalJudgeModels=<id>[,<id>]`.

Without `enableEval`, the API has no secret name and no grant, tags fail closed and
every session is a normal one, so the API change is inert. A missing or unusable key
is cached for 5 minutes, and malformed tags are rejected before any Secrets Manager
call, so `eval` fields from other clients cost nothing.

## Workflow

1. **Extract** drafts from the user-story Markdown (the PDFs are not used):
   ```powershell
   evals/.venv/Scripts/python -m evals extract --source "C:\Users\<you>\Documents\TestDocs"
   ```
   The deterministic parse copies these verbatim from each document: the story, acceptance criteria,
   reference conversation, content required, testing checks, variants and negative cases.

   With AWS credentials, a Bedrock call per story also drafts:
   - a synthetic persona
   - hidden facts for the simulator
   - one parent message per variant and per negative case
   - suggested situation keys

   `--no-llm` skips that call. Probes without a message are skipped at run time.

   Re-running rewrites only unreviewed drafts. It keeps earlier persona and message drafts,
   and never touches reviewed files unless you pass `--overwrite`.
2. **Review** every `scenarios/j*_f*/*.yaml`:
   - Fix anything the PDF conversion garbled.
   - Check the persona and messages are synthetic and natural.
   - Set `testable: false` for stories the chat cannot do. For example, 11F asks to track actions,
     and other stories ask for downloadable checklists.
   - Set `modes: [standard, guideline]` where both should be compared.
   - Set `reviewed: true`.
3. **Review `scenarios/label_map.yaml`.** It maps each journey number to a catalog key and each
   story to its expected situation keys:
   - Clusters marked `suggested_by: kiro` were proposed from the story text against the repo's
     fallback catalog (`helpers/journeys.py`). Check them against the live catalog in the admin
     Journeys page, or run extract with `--catalog admin`.
   - Set `reviewed: true` when done.
4. `python -m evals validate --for-scoring` must report no problems.
5. Run the **smoke test** first. It sends one tagged message, prints the phase and routing,
   checks the session is excluded from analytics (needs `KC_ADMIN_ID_TOKEN`) and deletes it:
   ```powershell
   evals/.venv/Scripts/python -m evals --env-file evals/.env smoke --yes
   ```
6. **Run** a small batch (the default limit is 3 stories):
   ```powershell
   evals/.venv/Scripts/python -m evals --env-file evals/.env run --stories 111,114,211 --modes standard,guideline --yes
   ```
   Useful flags:
   - `--journey 1`, `--limit N`
   - `--probes-only`, `--journeys-only`
   - `--max-turns`, `--follow-up-turns 1`
   - `--bedrock-eval --wait`, `--no-judge`, `--keep-sessions`

   Output goes to `results/<run_id>/`: `report.md`, `report.json`, `probes/`, `journeys/`,
   `judge/` and `bedrock/`.
7. You can re-score or rebuild an existing run:
   - `judge --run <id> [--force]`
   - `bedrock-eval --run <id> [--wait]` starts the Bedrock jobs. It refuses if the run already
     has jobs, so you never pay twice by accident; pass `--new` to start a fresh set.
   - `bedrock-eval --run <id> --collect [--wait]` starts nothing. It checks the run's existing
     jobs, fetches the metrics of completed ones and updates the report. Use it after `--wait`
     gives up (4 hours per job) or when you started the jobs without `--wait`. Large jobs
     (40+ records) can take several hours.
   - `report --run <id>`

## What is measured

**Routing (deterministic).** These are read back from `GET /chat_sessions/user/{id}`
(`metadata.routing.route`) after each turn:

- journey accuracy
- situation accuracy (the primary situation is in the story's expected keys; secondary-situation
  matches are reported separately)
- the false-positive rate on negative cases (routed to the story's own journey)
- confusion tables

Probes and the first and final journey turns are reported separately. Guideline mode has no
routing, so its sessions are skipped here.

**Journeys.** Each journey stops at the first guidance turn, which is SUGGESTION in standard mode
or a cited answer in guideline mode. It also stops at `--max-turns`, on an error, or when a
per-user limit is reached. The daily message limit arrives as a normal `complete` event with the
text "Daily message limit exceeded…", and the harness detects it.

**Judge** (one forced-tool call per transcript, scores 0-1):

| Score | What it checks |
|---|---|
| Reference flow | Each story step, by whether it was in the first reply, later, partly, or absent |
| Acceptance criteria | Criteria and testing checks: met, partial, not met, or N/A |
| Detective | Questions before guidance: relevance, repetition, premature guidance |
| Product rules | No legal advice, blame, speculation or deficit language; family-friendly; collaborative |
| Grounding | Guidance stays within the cited source previews |

The rubric text is in `judge/rubrics/`.

**Bedrock Evaluations.** One job runs per mode, because a job takes only one RAG source. Each
record holds the conversation, a reference (the expectations plus the reference flow), the guidance
reply and its source previews:

- Built-in metrics: Correctness, Completeness, Helpfulness, LogicalCoherence, Faithfulness,
  Harmfulness, Stereotyping.
- Seven custom metrics reuse the product rules and acceptance criteria.

Sources are the trimmed public previews (`to_public_source`), so faithfulness is approximate.

**Mode comparison.** `--modes standard,guideline` runs each scenario once per mode. Each run uses
a session-level override set by the signed tag. The report shows guideline minus standard per
story and per score. With `KC_ADMIN_ID_TOKEN`, it also records the global prompt mode before and
after the run.

## Cost and load

Each turn in the app makes:

- a Haiku router call
- a Haiku or Sonnet answer
- a Haiku grounding check on guidance turns
- a title call on the first turn
- a Cohere embedding and a guardrail check

A journey is usually about 5 turns, plus about 4 Haiku simulator calls and one Opus judge call
(about 10k input tokens). A full run of all 71 stories in both modes is roughly:

- 140 journeys
- about 160 probes
- about 300 anonymous users
- 1,000+ chat turns

Start small and check Bedrock pricing for current rates.

## Prod cautions

- **Concurrency is 1, with pacing between turns and users.** The account's Lambda concurrency
  limit is low (about 10), and each harness turn competes with real families.
- **WAF limits.** About 100 unauthenticated requests per IP per 5 minutes covers user creation
  (`GET /user/publicToken`). The client backs off on 429s and on WAF blocks (non-JSON 403).
- **Per-user limits.** Each anonymous user gets 45 messages and 10,000 characters per day. The
  harness uses a fresh user per probe or journey and stops a journey before a user's budget runs out.
- **Cleanup.** Sessions are excluded from admin analytics as soon as they are created. They are
  deleted once the result file is saved. Any that could not be deleted are listed in
  `run.json → cleanup_failed`, and all of them carry the run's `eval_run_id`.
- **Admin user list.** Harness users still appear in the admin user list.
- **No feedback, no intro flag.** The harness never sends feedback and never sets
  `is_intro_message`, which would skip the guardrail.
- **Synthetic data only.** Personas are synthetic. Do not put real family details in scenarios.

## Signed tag and the future dual mode

The harness signs a tag with the EvalStack key and sends it as the top-level `eval` field on
`POST /chat_sessions`. It never goes inside `metadata`.

```
eval = {run_id, mode, exp, sig}
sig  = hex(HMAC-SHA256(signingKey, f"{userId}.{run_id}.{mode}.{exp}"))
```

`handlers/utils/evalTag.js` checks:

- the signature, with a timing-safe compare, bound to the caller's user id
- the `run_id` format
- the mode
- an expiry no more than 24 hours ahead

A valid tag sets the server-only columns. Anything else creates a normal session, and the response
never says why. Neither the tag nor the key is logged.

textGeneration reads `prompt_mode_override` through one function, `config.resolve_prompt_mode`,
and never changes the global `PROMPT_MODE`. When guideline and standard modes are merged into a
dual mode, replace that function (and drop or repurpose the column). The callers and this harness's
`--modes` flag can stay as they are.
