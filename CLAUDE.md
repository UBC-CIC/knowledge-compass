# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### CDK (Infrastructure) — run from `/cdk`
```bash
npm run build       # TypeScript compile
npm run watch       # TypeScript watch mode
npm run test        # Jest tests
npm run cdk         # CDK CLI
```

### Frontend — run from `/frontend`
```bash
npm run dev         # Vite dev server
npm run build       # tsc type-check + Vite build
npm run lint        # ESLint
npm run preview     # Preview built output
```

### CDK Deploy — requires context variables
```bash
cdk deploy --all \
  -c StackPrefix=KC \
  -c environment=dev \
  -c githubRepo=your-org/your-repo \
  -c githubBranch=main \
  -c versionNumber=1
```
`StackPrefix` prefixes all stack and resource names. Deploy only `KC-Database KC-DBFlow` to run migrations without touching other stacks.

### Scripts (research/prototype — not deployed)
```bash
cd scripts
pip install -r requirements.txt
playwright install chromium
python crawl_test.py <seed_url> --max-pages 50              # crawl only
python crawl_test.py <seed_url> --max-pages 50 --write-db   # crawl + embed + write to RDS
```

---

## Architecture

This is a serverless AWS-native RAG chatbot. The core data flow is:

```
Browser (React + Amplify)
  → REST API Gateway (WAF) → Node.js Lambda handlers → RDS Proxy → PostgreSQL 16
  → WebSocket API Gateway  → textGeneration Lambda (Python) → Bedrock KB (RAG)
                                                            → Claude Sonnet 4.6 (generation)
                                                            → Claude Haiku 4.5 (query rewrite)
                                                            → Cohere Embed v3 (embeddings)
                                                            → OpenSearch Serverless (vector store)
```

### CDK Stacks (in dependency order)

| Stack | Key Resources |
|---|---|
| `VpcStack` | VPC (10.0.0.0/16), public + private-with-egress + isolated subnets, 1 NAT GW, VPC endpoints |
| `DatabaseStack` | RDS PostgreSQL 16 (isolated subnet), RDS Proxy, 3 Secrets Manager secrets, 30-day secret rotation |
| `DBFlowStack` | Trigger-on-deploy Lambda: runs `node-pg-migrate` + creates `app_rw`/`app_tc` DB users |
| `CICDStack` | CodePipeline + CodeBuild + ECR repo for `vectorIndexManagerSigV4` Docker image |
| `KnowledgeBaseStack` | S3 docs bucket, OpenSearch Serverless (VECTORSEARCH), Bedrock Knowledge Base, web crawler data source |
| `ApiGatewayStack` | Cognito User Pool + Identity Pool, REST API, WebSocket API, WAF, all Lambda functions |
| `AmplifyStack` | Amplify app (deploys `frontend/`), injects Cognito/API env vars at build time |

`KnowledgeBaseStack` depends on `CICDStack` (needs the ECR image before creating the vector index Lambda). `ApiGatewayStack` depends on both.

### Authentication

- **Students (unauthenticated):** `publicTokenFunction` issues 15-min JWTs → verified by `userAuthorizerFunction`
- **Admins:** Cognito email/password → `adminAuthorizerFunction` checks Cognito group membership
- **WebSocket:** JWT verified in `websocket/connect.js` before connection is accepted

### RAG Pipeline (`/cdk/lambda/textGeneration/`)

`chat.py` orchestrates two phases:
1. **Detective phase** — gathers user interests via conversation (no KB retrieval)
2. **Suggestion phase** — rewrites query with Haiku 4.5 → retrieves from Bedrock KB → generates response with Sonnet 4.6 → scores grounding via `intervention.py`

`intervention.py` computes support and scope scores against retrieved chunks to classify responses as grounded, partially grounded, or hallucinated — attaching a warning to the message stored in PostgreSQL.

All prompts and model settings (temperature, top_p, thresholds) are loaded dynamically from the `system_messages` and `system_settings` DB tables via `config.py`, not hardcoded.

### Database

PostgreSQL 16 (`KC` database). Application connects via RDS Proxy as `app_rw`. Migration runner (`node-pg-migrate`) tracks applied migrations in `pgmigrations`. Key tables:

- `system_messages` — versioned LLM prompt templates; admins update these via the admin dashboard at runtime
- `system_settings` — single-row config (rate limits, model params, grounding thresholds)
- `chat_sessions` / `chat_messages` — conversation history; `chat_messages.sources` is JSONB
- `crawl_sources` / `crawl_pages` / `page_chunks` — web crawler RAG tables added in migration `001`; `page_chunks.embedding` is `vector(1024)` with an HNSW index

### Knowledge Base Stack — Custom Resource Sequencing

Three custom resource Lambdas must fire in order during `cdk deploy`:
1. `ecrImageWaiter` — polls ECR until the Docker image exists (triggers CodePipeline if missing)
2. `vectorIndexManagerSigV4` (Docker) — creates the knn vector index in OpenSearch Serverless
3. `knowledgeBaseProvisioner` — creates the Bedrock Knowledge Base pointing at AOSS

If deploying fresh, CodePipeline must complete its first run before `cdk deploy` can finish.

### Frontend

React 19 + TypeScript + Vite + Tailwind + shadcn/ui. Two main pages:
- `ChatInterface` — student-facing chat UI (WebSocket for streaming responses)
- `AdminDashboard` — knowledge base management, analytics, system message editing

Amplify injects all runtime config (`VITE_*` env vars) at build time from SSM parameters set by `ApiGatewayStack` and `AmplifyStack`.

### Scripts Directory

`/scripts/` is a research/prototype workspace, not deployed to AWS. `crawl_test.py` is a standalone crawler that writes embeddings directly to the `page_chunks` table in RDS (bypassing the Bedrock KB pipeline). It uses IAM token auth against RDS and Cohere Embed v3 via Bedrock. Config constants (`REGION`, `DB_HOST`, `DB_USER`) are at the top of the file.
