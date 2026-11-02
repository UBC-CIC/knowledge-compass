# Security Overview

**Project:** Knowledge Compass
**Document Type:** Public Security Architecture Overview
**Last Updated:** October 2026

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Security Architecture](#2-security-architecture)
3. [Authentication & Authorization](#3-authentication--authorization)
4. [API Security](#4-api-security)
5. [Network Security](#5-network-security)
6. [Data Protection](#6-data-protection)
7. [GenAI Security](#7-genai-security)
8. [Monitoring & Compliance](#8-monitoring--compliance)
9. [Accepted Risks and Operator Actions](#9-accepted-risks-and-operator-actions)
10. [Security Contact](#10-security-contact)

---

## 1. Introduction

Knowledge Compass is a conversational assistant that answers questions from a curated knowledge base. This page summarizes its security controls.

---

## 2. Security Architecture

### 2.1 High-Level Architecture

```
  Browser ──▶ Amplify Hosting (CloudFront managed by Amplify) ──▶ SPA (static files)
  Browser ──▶ AWS WAF ──▶ API Gateway REST ──▶ Lambda authorizers ──▶ Lambda (VPC)
  Browser ──▶ API Gateway WebSocket (no WAF, see §9) ──▶ Lambda (VPC)

  Lambda (VPC) ──▶ RDS Proxy (TLS) ──▶ PostgreSQL + pgvector (encrypted, isolated subnets)
               ──▶ S3 ingest bucket (encrypted, no public access)
               ──▶ Amazon Bedrock models and guardrails
```

AWS Shield Standard applies automatically to AWS edge and API endpoints; the stacks do not deploy it.

### 2.2 Security Layers Summary

| Layer | Components | Security Controls |
|-------|------------|-------------------|
| **Edge** | Amplify Hosting (managed CloudFront), AWS WAF on the REST API | TLS, managed rule groups and per-IP rate limits on REST only |
| **Application** | API Gateway, Lambda | Authentication, authorization, input validation |
| **Data** | RDS, S3, Secrets Manager | Encryption, access control, credential rotation |
| **AI/ML** | Bedrock models and guardrails, pgvector retrieval | PII protection, prompt security, output validation |

---

## 3. Authentication & Authorization

### 3.1 Dual Authentication Model

| | Admin users | Public users |
|---|---|---|
| **Identity** | Amazon Cognito: email and password, verified email, `admin` group | Anonymous; no account or email |
| **MFA** | TOTP MFA required | None |
| **Token** | Cognito ID token (1 hour) | Custom JWT access token (15 minutes), minted from a 30-day credential and refreshed automatically |
| **Authorizer** | Admin authorizer (Cognito JWT and `admin` group) | User authorizer (custom JWT bound to one user) |

### 3.2 Authorization Controls

| Control | Implementation |
|---------|----------------|
| **Role-Based Access** | Admin vs. user roles enforced at API and handler level |
| **Resource Ownership** | Users can only access their own sessions and data |
| **Session Validation** | UUID format validation and ownership verification |
| **Token Expiration** | Short-lived tokens with automatic refresh |

### 3.3 Password Policy

- Minimum 10 characters
- Requires uppercase, lowercase, digits, and symbols
- Account recovery via verified email only

---

## 4. API Security

### 4.1 Request Security Pipeline

A REST request passes WAF rules (block attacks), stage throttling (throttle excess), OpenAPI request validation (reject invalid requests) and a Lambda authorizer (deny unauthorized callers), in that order.

### 4.2 WAF Rules

| Rule Category | Protection |
|---------------|------------|
| **Managed Rules** | SQL injection, XSS, path traversal, and common attacks |
| **Rate Limiting** | Per-IP ceilings scoped by URI path (token minting, chat) plus a global per-IP ceiling. Request headers do not select a bucket. |
| **Endpoint Protection** | Stricter limits for expensive AI operations |

The web ACL covers the REST API only. The chat WebSocket API and the Amplify-hosted SPA are not behind WAF; see [section 9](#9-accepted-risks-and-operator-actions).

### 4.3 Request Validation

| Control | Detail |
|---------|--------|
| **OpenAPI Schema** | Request structure validated against specification |
| **Input Sanitization** | UUID format, length limits, enum validation |
| **Parameterized Queries** | SQL injection prevention at the database layer |

### 4.4 CORS Configuration

- Allowed origins come from the SSM parameter `/<STACK-PREFIX>-Api/API/AllowedOrigins`; a response echoes the request `Origin` only if it is listed
- OPTIONS preflight and gateway error responses use the deployed SPA origin (stage variable `allowedOrigin`)
- Fails closed: a missing `ALLOWED_ORIGIN_PARAM`, an SSM read failure, or a `*` entry in the parameter never yields a wildcard origin (failures are not cached)
- `Access-Control-Allow-Methods` lists only the methods each function serves

### 4.5 Frontend Security Headers

Amplify Hosting adds these to every file it serves (`spaSecurityHeaders` in `cdk/lib/amplify-stack.ts`):

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` denying camera, microphone, geolocation, payment and USB
- A Content Security Policy: same-origin scripts only, no framing (`frame-ancestors 'none'`), and `connect-src` limited to the REST and WebSocket APIs, the Cognito user pool and S3 presigned uploads

The CSP currently ships as `Content-Security-Policy-Report-Only`: violations are logged in the browser console but nothing is blocked. After a dev deploy shows no violations, rename the header to `Content-Security-Policy`. Header changes take effect on the branch's next Amplify deploy.

---

## 5. Network Security

### 5.1 VPC Architecture

| Subnet | Runs | Internet access |
|---|---|---|
| Public | NAT gateway, internet gateway | Yes |
| Private | Lambda functions | Outbound only, through NAT |
| Isolated | RDS PostgreSQL, RDS Proxy, VPC endpoints for AWS services | None |

### 5.2 Network Controls

| Control | Implementation |
|---------|----------------|
| **Subnet Isolation** | Database in isolated subnets with no internet route |
| **Security Groups** | Scoped ingress rules, VPC CIDR only |
| **VPC Endpoints** | Private connectivity to AWS services (no public internet) |
| **VPC Flow Logs** | Network traffic auditing |

### 5.3 Encryption in Transit

| Connection | Protocol |
|------------|----------|
| API Gateway | HTTPS / TLS 1.2+ (HTTP not accepted) |
| WebSocket | WSS |
| RDS Proxy → Database | TLS required |
| Lambda → AWS services | TLS via VPC endpoints |

---

## 6. Data Protection

### 6.1 Data Classification

| Data Type | Classification | Protection |
|-----------|----------------|------------|
| User credentials | Sensitive | Cognito managed, never stored in app |
| Chat messages | Private | Encrypted at rest, user-scoped access |
| Session data | Private | UUID-based, ownership validated |
| Knowledge base | Internal | Encrypted, admin-only upload |
| System config | Internal | Database stored, admin-only access |

### 6.2 Encryption at Rest

| Resource | Encryption |
|---|---|
| RDS PostgreSQL (including vectors) | AES-256 storage encryption, AWS managed key |
| S3 buckets | SSE-S3 (S3-managed keys) |
| Secrets Manager secrets | AWS managed key |
| API Gateway (REST and WebSocket) and WAF log groups | Customer-managed KMS key (`apiLogsKey`, rotation on) |

Encryption in transit is listed in [§5.3](#53-encryption-in-transit); Bedrock calls also use TLS. To switch other resources to customer-managed keys, see [`Docs/AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md).

### 6.3 Credential Management

| Credential | Storage | Rotation |
|------------|---------|----------|
| Database credentials (admin) | AWS Secrets Manager | 30-day automatic |
| Database credentials (app users) | AWS Secrets Manager | 30-day automatic |
| JWT signing key | AWS Secrets Manager | Manual |
| Cognito pool, client and identity pool IDs (identifiers, not secrets; read by the frontend build) | AWS Secrets Manager | N/A (static IDs) |

### 6.4 S3 Bucket Security

| Control | Detail |
|---------|--------|
| **Block Public Access** | Enabled on all buckets |
| **SSL Required** | All requests must use HTTPS |
| **Presigned URLs** | Short expiration for uploads |
| **Content-Type Validation** | Enforced for uploaded files |

### 6.5 Guest Data Retention and Limits

| Control | Detail |
|---------|--------|
| **Retention** | A daily job (`cdk/lambda/handlers/retentionHandler.js`, 09:00 UTC) deletes each guest user, with all their chats, messages and feedback, once their most recent activity is more than 90 days old. Staff (Cognito) rows are never touched. |
| **Analytics rollup** | Before deleting, the job keeps per-day counts only (sessions, messages, questions, thumbs up/down) in `analytics_archive` under a fresh anonymous number that cannot be linked back to the user. Admin analytics adds these to live data, so totals do not drop. Written feedback text is not kept. |
| **Limit bookkeeping** | The same job prunes `daily_usage_requests` after 2 days and `user_daily_usage` after 7 days. |
| **Session cap** | Each guest can start 20 new chats per UTC day (`POST /chat_sessions` returns 429 `DAILY_SESSION_LIMIT_EXCEEDED`). Deleting a chat does not free a slot. |
| **Monitoring** | A CloudWatch alarm notifies the ops topic if the retention job fails. |

---

## 7. GenAI Security

### 7.1 AI Security Pipeline

```
  USER INPUT
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  1 · INPUT VALIDATION                                       │
  │      · Length limit (admin setting, default 2,000 chars)    │
  │      · Format validation                                    │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  2 · BEDROCK GUARDRAILS                                     │
  │      · PII Detection & Anonymization                        │
  │      · Prompt Attack Detection                              │
  │     ✗  Blocked → return denial  (no LLM call made)          │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  3 · RAG RETRIEVAL                                          │
  │      · pgvector similarity search                           │
  │      · Source document retrieval                            │
  │      · Retrieved text marked as data, tags escaped          │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  4 · LLM GENERATION                                         │
  │      · Grounded in retrieved context                        │
  │      · System prompts enforce topic scope                   │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  5 · OUTPUT GUARDRAIL                                       │
  │      · Content filters (hate, insults, sexual, violence)    │
  │      · High-risk identifiers masked                         │
  │     ✗  Blocked → safe message, no citations                 │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  6 · OUTPUT VALIDATION                                      │
  │      · LLM grounding check against the cited sources        │
  │      · Warning added if the response is not grounded        │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  RESPONSE TO USER
```

### 7.2 PII Protection

| Category | Protected Data Types |
|----------|---------------------|
| **Contact** | Email, phone, street addresses and Canadian postal codes (custom regex filters) |
| **Identity** | Name, age, username |
| **Financial** | Credit card numbers, bank accounts |
| **Government** | Social insurance numbers, health numbers |
| **Technical** | IP addresses, URLs |

Coarse location (province/territory, city, school board) is intentionally not masked, because answers depend on jurisdiction; it is still never logged.

### 7.3 Prompt Security

| Control | Description |
|---------|-------------|
| **Prompt Attack Detection** | Identifies and blocks injection attempts |
| **Untrusted Context** | Retrieved documents are wrapped as data with an instruction not to follow anything inside them; tag-like text is escaped so a crawled page cannot close the block |
| **Scope Enforcement** | System prompts restrict scope to inclusive education in Canada |
| **Guardrails** | Strict boundaries on acceptable responses |

For guardrail configuration details, see [`Docs/BEDROCK_GUARDRAILS.md`](./BEDROCK_GUARDRAILS.md).

### 7.4 Output Validation

| Control | Description |
|---------|-------------|
| **Output Guardrail** | Every final answer is screened before it is saved or sent: content filters replace a flagged answer with a safe message, and passwords, PINs, card, bank, health and SIN numbers are masked. A guardrail error fails closed. Streamed tokens are replaced by the screened answer when generation completes. |
| **Grounding Check** | A separate model call (`textGeneration/helpers/intervention.py`) checks the answer against its cited sources; answers that are not grounded carry a warning to the user |

---

## 8. Monitoring & Compliance

### 8.1 Security Logging

All logs go to CloudWatch Logs; the alarms in [§8.2](#82-alerting) read CloudWatch metrics.

| Log Type | Content | Retention |
|----------|---------|-----------|
| **API Access Logs** | Request metadata, source IP, status, request id, and the authorizer identity: principal id, user id (admin Cognito sub or bound guest id), role, admin email (masked by the data-protection policy), access-token id (`jti`) | 1 year (retained on stack deletion; `apiLogRetention` in `api-stack.ts`) |
| **Lambda Logs** | Function execution, errors (body excluded) | 90 days for Lambda and CodeBuild (`SERVICE_LOG_RETENTION` in `cdk/lib/log-retention.ts`) |
| **ECS Task Logs** | Crawler and transcriber output | 30 days |
| **VPC Flow Logs** | Network traffic metadata | Configurable |
| **WebSocket Logs** | Connection events, route keys (no authorizer fields: the WebSocket API has no API Gateway authorizer) | 1 year (retained on stack deletion) |
| **WAF Logs** (`aws-waf-logs-<STACK-PREFIX>-Api`) | Blocked requests only, `Authorization` header redacted | 1 year, customer-managed key (retained on stack deletion) |
| **Admin audit table (`admin_audit`)** | Actor (Cognito sub/email from the admin authorizer), action, target ids (never content or setting values), request id, for promote_user, admin user creation, system-message create/activate/delete, system-settings updates and data-source deletion; written in the same transaction as the change; append-only (trigger blocks UPDATE/DELETE/TRUNCATE) | Indefinite (database) |
| **Token issuance log** | One line per access token from `GET /user/publicToken`: token id (`jti`), bound guest id or null, source IP, user agent, request id (never the token or credential) | Lambda log retention |
| **Worker task log** | One line per self-invoked ingestion/embedding task with the originating admin (sub/email/request id, null for scheduler/ECS paths) | Lambda log retention |

### 8.2 Alerting

| Alert | Trigger | Purpose |
|-------|---------|---------|
| **Concurrency Alarm** | Lambda approaching reserved limit | Prevent service degradation |
| **Error Rate Alarm** | Elevated 5XX responses | Detect service issues |
| **WAF Block Alarm** | High block rate | Detect attack patterns |
| **Dropped Worker Event Alarm** | A knowledge base ingestion or embedding self-invocation is dropped by Lambda | Surface a lost batch (no dead-letter queue: the payload carries the worker invoke token) |

### 8.3 Compliance Summary

| Control Area | Status | Notes |
|--------------|--------|-------|
| **Encryption at Rest** | ✅ Enabled | AWS managed keys (CMK upgrade available — see [`AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md)) |
| **Encryption in Transit** | ✅ Enabled | TLS enforced on all connections |
| **Access Control** | ✅ Enabled | Role-based, least privilege |
| **Audit Logging** | ✅ Enabled | Privileged admin actions (role elevation, admin creation, system messages/settings, data-source deletion) are recorded with the acting administrator in the append-only `admin_audit` table; API access logs carry the authorizer identity and token id and are kept 1 year; token issuance and admin-started worker tasks are logged with their ids and originating admin. CloudTrail covers AWS API calls. |
| **Credential Management** | ✅ Enabled | Secrets Manager with automatic rotation |
| **PII Protection** | ✅ Enabled | Automatic anonymization via Bedrock Guardrails |
| **Input Validation** | ✅ Enabled | Schema and application-level validation |
| **Rate Limiting** | ✅ Enabled | Multi-layer WAF and API Gateway throttling |

---

## 9. Accepted Risks and Operator Actions

Known gaps that are accepted by design, and settings an operator must change outside the code. Each comes from the October 2026 architecture review (finding ids in brackets).

### 9.1 Accepted by design

| Area | What remains | Why it is accepted | Mitigation in place |
|------|--------------|--------------------|---------------------|
| **WebSocket API not behind WAF** [A-03] | The chat WebSocket API has no WAF web ACL | AWS WAF cannot attach to API Gateway WebSocket (or HTTP) APIs; only REST API stages are supported | Token verified on `$connect`; stage-wide throttles; a per-connection limit on `generate_text` messages; the input guardrail. Putting CloudFront (with WAF) in front would only inspect the initial upgrade request. |
| **Wildcard API id in Lambda invoke permissions** [A-11] | API Gateway invoke permissions name `*` for the REST API id, and text generation's `ManageConnections` grant names `*` for the WebSocket API id | Naming the API id would create a CloudFormation dependency cycle (the OpenAPI body references the functions) | Every grant is pinned to this account and region and to its route, stage or `POST /@connections`; the authorizers still gate every request. Only an API Gateway in the same account could use the wildcard. |
| **Single-AZ database** [A-16] | RDS runs in one Availability Zone with 7-day automated backups | Cost, for the current scale | Encrypted storage, TLS only, isolated subnets, deletion protection, rotated credentials. For production consider `multiAz: true` and backups aligned with the data-retention policy (`cdk/lib/database-stack.ts`). |
| **Ingest buckets are deleted with the stack** | The S3 ingest bucket (uploaded originals, transcript outputs, cached OCR text) and its access-log bucket use `RemovalPolicy.DESTROY` with `autoDeleteObjects: true`, so deleting the ingestion stack permanently deletes their contents | Content should not outlive the deployment that processed it. The originals are not needed to change embedding models: a rebuild re-embeds from the chunk text stored in the database | Deleting a stack is a deliberate, approved action. The database (chunk text and vectors) has deletion protection, and RDS takes a final snapshot if the database is deleted. To keep the originals, copy the bucket before teardown (`cdk/lib/ingestion-stack.ts`). |
| **Shared code in the ingestion images** [A-13] | The crawler and transcriber images keep their own copy of `embeddings.py` and `url_safety.py` | A container image cannot use a Lambda layer | The Lambdas share one copy through the `kc_shared` layer. The pipeline's test stage fails if the container `embeddings.py` drifts from the layer or `url_safety.py` drifts from the knowledge base copy. |

### 9.2 Operator actions

| Action | Where | When |
|--------|-------|------|
| **Add WAF to the SPA** [A-03] | Amplify Hosting supports a WAF web ACL directly (Amplify console → Hosting → Firewall, or CDK). The web ACL must be CLOUDFRONT-scoped, created in us-east-1, in the same account as the app. AWS and Amplify bill separately for it. | Optional: the SPA serves static files only, and the APIs it calls already have their own controls |
| **Reserve Lambda concurrency** [A-14] | Request an account Lambda concurrency quota of at least 350, then deploy with `-c enableReservedConcurrency=true` | Before public launch. Until then the public Lambdas run unreserved, so a traffic spike can starve admin functions; WAF rate rules and WebSocket throttles are the backstop |
| **Enable Cognito threat protection** [A-17] | Cognito Plus feature plan with threat protection (compromised-credential and adaptive authentication) in ENFORCED mode, on the admin user pool | Optional. Admin sign-in already requires TOTP MFA, a strong password policy and SRP; only users in the `admin` group reach the admin role |
| **Accept or fix ECR scan findings** | `ECR_SCAN_ALLOWED_FINDINGS` in `cdk/lib/cicd-stack.ts` (each entry needs a reason), or a newer base image | Whenever the image scan gate blocks a build on a CRITICAL or HIGH finding |
| **Enforce the Content Security Policy** | Rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in `cdk/lib/amplify-stack.ts` | After a dev deploy shows no CSP violations in the browser console ([section 4.5](#45-frontend-security-headers)) |

### 9.3 Authorization model (reviewed, no change needed) [A-17]

The identity pool issues no unauthenticated identities and maps roles from the token, denying ambiguous ones, so the admin role is reachable only through the `admin` group claim; the default authenticated role holds no permissions. The admin authorizer verifies the Cognito ID token and requires `admin` group membership from the token itself.

---

## 10. Security Contact

Report suspected vulnerabilities privately to the project maintainers. Do not open a public issue.
