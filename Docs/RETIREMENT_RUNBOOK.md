# Bedrock KB / OpenSearch Retirement Runbook (R10)

> **Historical.** The Bedrock Knowledge Base stack is no longer part of the CDK app. This runbook is kept as a record and for deployments that still have a `<PREFIX>-KnowledgeBase` stack from before the retirement. For the current design see [`KNOWLEDGE_BASE_DOCUMENTATION.md`](./KNOWLEDGE_BASE_DOCUMENTATION.md).

> ⚠️ **DESTRUCTIVE — DO NOT AUTO-RUN.** This procedure deletes the production
> Bedrock Knowledge Base, the OpenSearch Serverless collection, and related
> resources. Execute it manually, step by step, only after the pgvector cutover
> has baked successfully (plan §6). Every step is reversible ONLY up to the point
> where infrastructure is deleted — read §5 (rollback) before starting.

This runbook makes the plan §6.4 edit list concrete and ordered. It is a checklist
for a human operator with the `nav-dev` (or prod) AWS profile; nothing here runs
automatically.

---

## 0. Preconditions (all must be true)
- [ ] R1 credential rotation done.
- [ ] Migrations 001/002/003 applied; corpus loaded into `sources`/`chunks`.
- [ ] `USE_PGVECTOR_RETRIEVAL=true` and `INGESTION_BACKEND=pgvector` have run in
      production for the agreed bake window with acceptable metrics (R9 harness).
- [ ] The R9 comparison thresholds are recorded and met.
- [ ] A recent DB backup/snapshot exists.

---

## 1. Flip to pgvector (reversible, no infra deletion)
This is the real cutover; it does NOT delete anything.
- [ ] Set `USE_PGVECTOR_RETRIEVAL=true` on the text-gen Lambda (already wired).
- [ ] Set `INGESTION_BACKEND=pgvector` on lambdaKnowledgeBase (already wired via
      `ingestionStack.ingestionEnv()`).
- [ ] Deploy; validate live traffic + run the R9 harness with `--backends pgvector`.
- [ ] **Bake** for the agreed window. Rollback at any time by flipping the flags
      back to `false`/`bedrock` and redeploying — no infra changes needed.

Do NOT proceed to §2 until the bake passes.

---

## 2. Code edits to remove the Bedrock dependency
Make these as ONE reviewed change (they are interdependent). File-and-line anchors
are from plan §6.4 / §15.

### 2a. `cdk/bin/cdk.ts`
- [ ] Remove the `KnowledgeBaseStack` import + `kbStack` instantiation + its
      `addDependency` calls + its entry in the `stacks[]` array.
- [ ] Remove the `vectorIndexManagerSigV4` entry from the CICD `lambdaFunctions`
      and `pathFilters` (only needed to bootstrap the AOSS vector index).
- [ ] Remove `knowledgeBaseBucket` / `knowledgeBaseSecret` passed to `ApiGatewayStack`
      and `knowledgeBaseBucketName` passed to `AmplifyStack`.
- [ ] Keep `IngestionStack` and its wiring intact.

### 2b. `cdk/lib/api-stack.ts`
- [ ] Drop `knowledgeBaseBucket` / `knowledgeBaseSecret` from `ApiGatewayStackProps`.
- [ ] Remove `KB_SECRET_NAME` env + the `secretsmanager:GetSecretValue` grant on
      `lambdaTextGen` (pgvector retrieval does not read the KB id).
- [ ] Remove the `bedrock:*IngestionJob` / `bedrock:*DataSource` grants,
      `KNOWLEDGE_BASE_BUCKET_NAME` env, and KB bucket grant on `lambdaKnowledgeBase`.
      The Lambda keeps its DB access, the ingestion env, and `grantRunTasks`.

### 2c. `cdk/lib/knowledge-base-stack.ts`
- [ ] Delete the file once nothing references it.

### 2d. Lambda source no longer used
- [ ] Delete `cdk/lambda/knowledgeBase/helpers/process_s3_batch.py` and
      `process_website_batch.py` (Bedrock-specific). Keep `process_crawler_batch.py`,
      `stage_data_sources*.py`, `start_ingestion_job.py`, `update_status.py`,
      `generate_presigned_url*.py`.
- [ ] In `start_ingestion_job.py`: remove the `process_s3_batch` / `process_website_batch`
      imports and the `bedrock` branch; make pgvector the only path (drop the
      `INGESTION_BACKEND` check or leave it defaulting to pgvector).
- [ ] In `main.py`: remove the `kb_id` fetch entirely (already skipped when pgvector).
- [ ] Delete `cdk/lambda/knowledgeBaseProvisioner/` and
      `cdk/lambda/vectorIndexManagerSigV4/` once the stack + provisioner are gone.

### 2e. text-gen helpers
- [ ] `helpers/config.py`: remove `KB_ID`, `KB_SECRET_NAME`, and the KB load in
      `load_config`.
- [ ] `helpers/chat.py`: either drop the `USE_PGVECTOR_RETRIEVAL` branch (pgvector
      unconditional) OR keep the flag defaulting true for one more release.
- [ ] `helpers/bedrock.py`: `retrieve_documents` can be deleted once the branch is
      gone. **KEEP `format_context_for_prompt`** — the pgvector path still uses it.

### 2f. OpenAPI
- [ ] Remove the presigned-URL and Bedrock-sync admin routes only if the repurposed
      admin flow no longer uses them; keep `/admin/data_sources[/batch]` and `/sync`
      (now pgvector-backed).

Verify after edits: `npm run build` (tsc) + full `cdk synth` must pass.

---

## 3. Deploy the code edits
- [ ] `cdk diff` and review carefully — confirm only KB/OpenSearch resources are
      being removed and nothing in Api/Ingestion/DB is unexpectedly replaced.
- [ ] Deploy `KC-Api` (and `KC-Amplify` if its props changed) FIRST, so the running
      system stops referencing KB before the KB stack is destroyed.
- [ ] Confirm live traffic is healthy on pgvector.

---

## 4. Destroy the KB stack + data cleanup
Only after §3 is healthy.
- [ ] `cdk destroy KC-KnowledgeBase` (removes the Bedrock KB, OpenSearch Serverless
      collection + policies, vector-index custom resource, KB provisioner, KB secret,
      and — per its RemovalPolicy — the KB S3 bucket).
- [ ] Confirm the OpenSearch Serverless collection + encryption/network/data-access
      policies are gone (they incur OCU cost). Check the console.
- [ ] KB S3 source bucket: if the new document-ingestion path still stages files
      there, MIGRATE first; otherwise let destroy remove it.
- [ ] Remove any KB-related CloudWatch alarms/outputs left behind.
- [ ] Remove the `vectorIndexManagerSigV4` ECR repo + its CICD build action (RETAIN
      policy means the repo must be deleted manually).

---

## 5. Rollback
- **Before §4 (infra still exists):** flip `USE_PGVECTOR_RETRIEVAL=false` +
  `INGESTION_BACKEND=bedrock`, redeploy `KC-Api`. Instant, no data loss.
- **After §4 (KB destroyed):** rollback requires REDEPLOYING `KC-KnowledgeBase` from
  the git history that still has it, re-provisioning the KB + OpenSearch collection,
  and re-ingesting sources. This is slow and lossy — which is why §1 bake + §3 health
  checks gate §4.

---

## 6. Post-retirement verification
- [ ] Chat works end-to-end on pgvector; sources/citations render.
- [ ] Admin ingestion (data_sources CRUD + sync -> ECS crawler/transcriber) works.
- [ ] No remaining references to `KB_SECRET_NAME`, `KB_ID`, `knowledgeBaseBucket`,
      `bedrock-agent`, or OpenSearch in the deployed stacks (grep the repo).
- [ ] AWS cost report shows OpenSearch Serverless OCU charges have stopped.
