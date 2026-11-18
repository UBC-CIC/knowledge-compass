# Deployment Guide

## Table of Contents

- [Deployment Guide](#deployment-guide)
  - [Table of Contents](#table-of-contents)
  - [Requirements](#requirements)
    - [Request Higher Bedrock LLM Invocation Quotas](#request-higher-bedrock-llm-invocation-quotas)
  - [Pre-Deployment](#pre-deployment)
    - [Create GitHub Personal Access Token](#create-github-personal-access-token)
  - [Deployment](#deployment)
    - [Step 1: Fork \& Clone The Repository](#step-1-fork--clone-the-repository)
    - [Step 2: Upload Secrets \& Parameters](#step-2-upload-secrets--parameters)
    - [Step 3: CDK Deployment](#step-3-cdk-deployment)
      - [Initialize the CDK stack](#initialize-the-cdk-stack)
      - [Deploy the stacks](#deploy-the-stacks)
      - [Optional context flags](#optional-context-flags)
      - [Stacks Deployed](#stacks-deployed)
    - [Step 4: Authorize the GitHub Connection and Build the Images](#step-4-authorize-the-github-connection-and-build-the-images)
  - [Post-Deployment](#post-deployment)
    - [Step 1: Build AWS Amplify App](#step-1-build-aws-amplify-app)
    - [Step 2: Configure Admin User](#step-2-configure-admin-user)
    - [Step 3: Visit Web App](#step-3-visit-web-app)
    - [Step 4: Add Content](#step-4-add-content)
    - [Adding Custom Allowed Origins](#adding-custom-allowed-origins)
  - [Troubleshooting](#troubleshooting)
  - [Cleanup](#cleanup)
    - [Taking down the deployed stack](#taking-down-the-deployed-stack)

## Requirements

Accounts: [AWS](https://aws.amazon.com/account/) and [GitHub](https://github.com/).

Tools:

- [git](https://git-scm.com/downloads)
- [AWS CLI](https://aws.amazon.com/cli/) v2
- [Node.js](https://nodejs.org/en/download) 22 LTS with npm 10+
- [Python](https://www.python.org/downloads/) 3.12
- AWS CDK CLI: installed by `npm ci` in `cdk/`; run it as `npx cdk`

### Request Higher Bedrock LLM Invocation Quotas

Before launch, check the Bedrock "requests per minute" and "tokens per minute" quotas in the Service Quotas console for Claude Haiku 5.5 (`us.anthropic.claude-haiku-5-5`) and your embedding model (Amazon Titan Text Embeddings V2 on a new install). Request increases to match your expected traffic; approval can take 1–2 days. See [Bedrock service quotas](https://docs.aws.amazon.com/general/latest/gr/bedrock.html#limits_bedrock).

## Pre-Deployment

### Create GitHub Personal Access Token

Create a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) with access to the KC repository only: read-only for Contents and Metadata, read and write for Webhooks and Commit statuses. Keep its value for Step 2.

## Deployment

### Step 1: Fork & Clone The Repository

Fork this repository on GitHub (**Fork**, then **Create fork**), then clone your fork and install dependencies:

```bash
git clone https://github.com/<YOUR-GITHUB-USERNAME>/knowledge-compass.git
cd knowledge-compass/cdk && npm ci
cd ../frontend && npm ci
```

### Step 2: Upload Secrets & Parameters

Commands in this guide use bash. On Windows, use Git Bash or WSL. In PowerShell, replace the line-continuation `\` with a backtick and escape the inner JSON double quotes as `\"` (see the example after the two secrets).

Replace `<YOUR-PROFILE-NAME>` with your AWS CLI profile in every command.

GitHub personal access token:

```bash
aws secretsmanager create-secret \
  --name github-personal-access-token \
  --secret-string '{"my-github-token": "<YOUR-GITHUB-TOKEN>"}' \
  --profile <YOUR-PROFILE-NAME>
```

GitHub username (the owner of your fork):

```bash
aws ssm put-parameter \
  --name "KC-owner-name" \
  --value "<YOUR-GITHUB-USERNAME>" \
  --type String \
  --profile <YOUR-PROFILE-NAME>
```

Database username of your choice (for example `KCDatabaseUser`):

```bash
aws secretsmanager create-secret \
  --name KCSecrets \
  --secret-string '{"DB_Username":"<YOUR-DB-USERNAME>"}' \
  --profile <YOUR-PROFILE-NAME>
```

<details>
<summary>PowerShell version of the two secrets</summary>

```powershell
aws secretsmanager create-secret `
  --name github-personal-access-token `
  --secret-string '{\"my-github-token\": \"<YOUR-GITHUB-TOKEN>\"}' `
  --profile <YOUR-PROFILE-NAME>

aws secretsmanager create-secret `
  --name KCSecrets `
  --secret-string '{\"DB_Username\": \"<YOUR-DB-USERNAME>\"}' `
  --profile <YOUR-PROFILE-NAME>
```

</details>

Allowed email domains for **administrator** accounts, as a comma-separated list with no spaces, in lowercase (for example `example.ca,example.org`). Domains must match exactly; subdomains are not included. The Cognito pre-sign-up trigger rejects an account with any other domain, including one you create in the Cognito console. Public users have no account, so this list does not affect them.

```bash
aws ssm put-parameter \
    --name "/KC/AllowedEmailDomains" \
    --value "example.ca" \
    --type SecureString \
    --profile <YOUR-PROFILE-NAME>
```

<details>
<summary>PowerShell version of the GitHub username and allowed email domains</summary>

```powershell
aws ssm put-parameter `
    --name "KC-owner-name" `
    --value "<YOUR-GITHUB-USERNAME>" `
    --type String `
    --profile <YOUR-PROFILE-NAME>

aws ssm put-parameter `
    --name "/KC/AllowedEmailDomains" `
    --value "example.ca" `
    --type SecureString `
    --profile <YOUR-PROFILE-NAME>
```

</details>

The application uses Claude Haiku 5.5 for all text generation (router, detective, partial and suggestion replies, grounding check, titles, guideline labelling). It reads the model ID from the SSM parameter `/KC/LLM/HaikuArn`. You must create it before deploying.

```bash
aws ssm put-parameter \
    --name "/KC/LLM/HaikuArn" \
    --value "us.anthropic.claude-haiku-5-5" \
    --type String \
    --profile <YOUR-PROFILE-NAME>
```

<details>
<summary>PowerShell version of the model parameter</summary>

```powershell
aws ssm put-parameter `
    --name "/KC/LLM/HaikuArn" `
    --value "us.anthropic.claude-haiku-5-5" `
    --type String `
    --profile <YOUR-PROFILE-NAME>
```

</details>

### Step 3: CDK Deployment

The CDK deployment also creates the Bedrock guardrail; see [`BEDROCK_GUARDRAILS.md`](./BEDROCK_GUARDRAILS.md) to customize it.

The deployment creates a new VPC. To deploy into a VPC you already have, see [Deploying into an Existing VPC](./MODIFICATION_GUIDE.md#deploying-into-an-existing-vpc) before continuing.

Run the commands below from the `cdk/` directory.

#### Initialize the CDK stack

Bootstrap once per account and Region (skip if CDK has already been bootstrapped there):

```bash
npx cdk bootstrap aws://<YOUR_AWS_ACCOUNT_ID>/<YOUR_ACCOUNT_REGION> --profile <YOUR-PROFILE-NAME>
```

The bootstrap command is the same in PowerShell.

#### Deploy the stacks

```bash
npx cdk deploy --all \
  --context StackPrefix=<YOUR-STACK-PREFIX> \
  --context environment=dev \
  --context versionNumber=1.0.0 \
  --context githubRepo=knowledge-compass \
  --profile <YOUR-PROFILE-NAME>
```

<details>
<summary>PowerShell version of the deploy</summary>

```powershell
npx cdk deploy --all `
  --context StackPrefix=<YOUR-STACK-PREFIX> `
  --context environment=dev `
  --context versionNumber=1.0.0 `
  --context githubRepo=knowledge-compass `
  --profile <YOUR-PROFILE-NAME>
```

</details>

- `StackPrefix` is prefixed onto the stack names and the physical names of their resources.
- `environment` (`dev`, `test`, `prod`) sets the `Environment` tag and the CICD environment name; it defaults to `dev`.
- `versionNumber` is informational only; no stack uses it.
- `githubRepo` must match your fork's repository name.

Deployment takes 15–30 minutes. You will be asked to approve IAM and security group changes. During the deploy, complete [Step 4](#step-4-authorize-the-github-connection-and-build-the-images) as soon as the CICD stack finishes.

#### Optional context flags

Add any of these as `--context <flag>=<value>` to the deploy command. For any shared environment, set `alarmEmail` and `lifecycleAlertEmail`; without them, alarms and model lifecycle alerts have no subscriber.

| Flag | Default | Effect |
|---|---|---|
| `githubBranch` | `main` | Adds an Amplify branch (when not `main`), sets the CICD source branch, and sets the origin written to AllowedOrigins (`https://<githubBranch>.<app-id>.amplifyapp.com`). The origin is written only when the Amplify stack is first created; if you change the branch later, add the new origin yourself ([Adding Custom Allowed Origins](#adding-custom-allowed-origins)) |
| `alarmEmail` | none | Subscribes the address to the operational alarm topic |
| `lifecycleAlertEmail` / `lifecycleAlertEmailParam` | none | Subscribes to the model lifecycle alert topic. `lifecycleAlertEmailParam` is the name of an SSM String parameter holding the address; `lifecycleAlertEmail` wins if both are set |
| `monthlyBudgetUsd` | none | Creates a monthly AWS Budget in `<PREFIX>-Cost` with 50/80/100 % alerts to the alarm topic |
| `enableReservedConcurrency` | `false` | Reserves concurrency for the public Lambdas. The deploy fails unless the account Lambda concurrency quota is at least 350 |
| `enableEval` | `false` | Adds the `<PREFIX>-Eval` stack ([EVALS.md](./EVALS.md)) |
| `evalJobRegion` | stack Region | Region for Bedrock evaluation jobs; adds `<PREFIX>-EvalJobs` when it differs from the stack Region |
| `evalJudgeModels` | `us.anthropic.claude-opus-4-6-v1` | Comma-separated judge model or inference profile IDs |

#### Stacks Deployed

The CDK deployment creates the following stacks in dependency order:

| Stack | Description |
|---|---|
| `<PREFIX>-VpcStack` | VPC, subnets, security groups, and VPC endpoints |
| `<PREFIX>-Database` | RDS PostgreSQL instance and RDS Proxy |
| `<PREFIX>-DBFlow` | Database migration Lambda and schema setup |
| `<PREFIX>-CICD` | CodePipeline and the ECR repositories for the crawler and transcriber images |
| `<PREFIX>-Ingestion` | ECS Fargate cluster and task definitions for the crawler and transcriber, the S3 ingest bucket, and the EventBridge relay that reports Transcribe and ECS task results to the knowledge base Lambda |
| `<PREFIX>-Api` | API Gateway (REST + WebSocket), all Lambda functions, Cognito User Pool, guardrails, and the operational alarm topic |
| `<PREFIX>-Amplify` | AWS Amplify app connected to your GitHub repository |
| `<PREFIX>-Cost` | Cost Anomaly Detection alerts, plus a monthly budget when `-c monthlyBudgetUsd=<amount>` is set |
| `<PREFIX>-Eval` | Evaluation harness resources; deployed only with `-c enableEval=true` |
| `<PREFIX>-EvalJobs` | Bedrock evaluation job resources in `evalJobRegion`; deployed only with `-c enableEval=true` when that Region differs from the stack Region |

Embeddings and vector search run on pgvector in the RDS database.

### Step 4: Authorize the GitHub Connection and Build the Images

Do this step **while `cdk deploy --all` is still running**, in the AWS console in a browser. Leave the terminal running.

**Why:** AWS cannot read your GitHub fork until you approve it. Until then, the crawler and transcriber images cannot be built, and the `<STACK-PREFIX>-Ingestion` stack waits for them.

**When:** watch the terminal. Once it shows `<STACK-PREFIX>-CICD` as deployed, do the steps below. You have about 14 minutes before the Ingestion stack gives up waiting.

**1. Approve the GitHub connection**

1. Sign in to the AWS console with the same account and Region you are deploying to.
2. In the search bar at the top, type **CodePipeline** and open it.
3. In the left menu, expand **Settings** and click **Connections**.
4. Click the connection named `<STACK-PREFIX>-CICD-github-conn`. Its status is **Pending**.
5. Click **Update pending connection**. A GitHub window opens.
6. Sign in to GitHub if asked, and allow access for your GitHub account. When asked which repositories to allow, choose your `knowledge-compass` fork.
7. Click **Connect**. Back in the AWS console, the status changes to **Available**.

**2. Let the images build**

You don't need to do anything else. The deployment starts the `<STACK-PREFIX>-CICD-DockerImagePipeline` pipeline itself, and the terminal continues once both images are built. To follow progress, open **CodePipeline → Pipelines** and select that pipeline.

Each image is scanned for vulnerabilities before it is used. A CRITICAL or HIGH finding stops the build (the allow-list is `ECR_SCAN_ALLOWED_FINDINGS` in `cdk/lib/cicd-stack.ts`).

**3. If the terminal shows the Ingestion stack failed or timed out**

This usually means the connection was approved too late, or the image scan blocked the build.

1. Make sure the connection shows **Available** (part 1 above).
2. In **CodePipeline → Pipelines**, open `<STACK-PREFIX>-CICD-DockerImagePipeline`. If a stage is red, click **View details** to see why, fix it, then click **Release change** at the top right.
3. Wait until the pipeline shows every stage as **Succeeded**. You can confirm in **Amazon ECR → Repositories**: both `<stack-prefix>-cicd-crawler` and `<stack-prefix>-cicd-transcriber` should have an image tagged `latest`.
4. Back in the terminal, from `cdk/`, run the same `npx cdk deploy --all ...` command from [Deploy the stacks](#deploy-the-stacks) again, with the same `--context` values and optional flags. Stacks that already finished are skipped, and the Ingestion, Api and Amplify stacks are created.

You only do this on the first deployment. After that, any push that changes `cdk/containers/` rebuilds the images automatically.

## Post-Deployment

### Step 1: Build AWS Amplify App

1. In the AWS console, open **AWS Amplify** and select `<STACK-PREFIX>-Amplify-amplify` under **All apps**.
2. Select the `main` branch (or your `githubBranch` if you set one).
3. Click **Redeploy this version** and wait for the build (5–10 minutes).
4. The app page shows the `Amplify App ID` and the web app domain.

### Step 2: Configure Admin User

To create the first admin user:

1. Open **Amazon Cognito** and select the user pool `<STACK-PREFIX>-Api-UserPool`.
2. Click **Users**, then **Create user**.
3. Enter your email address as the username and email, and a temporary password. The email's domain must be in `/KC/AllowedEmailDomains`; otherwise creation fails with `PreSignUp failed with error Error validating email domain during pre-signup.`
4. Choose **Don't send an email invitation**, then **Create user**.
5. Select the user, click **Add user to group**, and choose `admin`.
6. Sign in at `<web app URL>/admin/login`. At first sign-in you set a new password.

Once one admin exists, add further admins through the API: `POST /admin/users` with `{ "display_name": "...", "email": "..." }` (admin ID token in `Authorization`). It creates the Cognito user, adds it to the `admin` group and records the admin in the database. Cognito emails the new admin a temporary password. The email must be in an allowed sign-up domain (`/KC/AllowedEmailDomains`). If the email already has a Cognito account, it is added to the `admin` group instead (response `200` rather than `201`).

### Step 3: Visit Web App

Open the web app URL shown in the Amplify console: `https://<githubBranch>.<app-id>.amplifyapp.com` (`main` by default). Families use this URL directly; administrators sign in at `/admin/login` on the same URL. See the [User Guide](./USER_GUIDE.md).

### Step 4: Add Content

A new deployment has no content, so the assistant cannot give grounded answers until you add some. Sign in to the admin console and add Inclusion Canada's websites, documents and videos from **Overview → Data sources**. Follow [Adding content](./USER_GUIDE.md#adding-content) in the User Guide for step-by-step instructions for websites, documents, video transcription, and CSV or Markdown files. Then ask a question in the chat to check that the new sources appear under the answer.

### Adding Custom Allowed Origins

Allowed CORS origins live in the SSM parameter `/<STACK-PREFIX>-Api/API/AllowedOrigins`. The Amplify URL is written on the first deployment. To allow another origin (a custom domain, or `http://localhost:5173` for development), read the current value and write it back with the new origin appended (comma-separated, no trailing slashes):

```bash
aws ssm get-parameter \
  --name "/<STACK-PREFIX>-Api/API/AllowedOrigins" \
  --profile <YOUR-PROFILE-NAME> \
  --query Parameter.Value --output text

aws ssm put-parameter \
  --name "/<STACK-PREFIX>-Api/API/AllowedOrigins" \
  --value "https://main.abc123.amplifyapp.com,https://your-custom-domain.com" \
  --type String \
  --overwrite \
  --profile <YOUR-PROFILE-NAME>
```

<details>
<summary>PowerShell version of the allowed origins</summary>

```powershell
aws ssm get-parameter `
  --name "/<STACK-PREFIX>-Api/API/AllowedOrigins" `
  --profile <YOUR-PROFILE-NAME> `
  --query Parameter.Value --output text

aws ssm put-parameter `
  --name "/<STACK-PREFIX>-Api/API/AllowedOrigins" `
  --value "https://main.abc123.amplifyapp.com,https://your-custom-domain.com" `
  --type String `
  --overwrite `
  --profile <YOUR-PROFILE-NAME>
```

</details>

Later CDK deployments do not overwrite origins you added.

## Troubleshooting

**CDK deployment fails with "Resource already exists"**

Another deployment uses the same names. Delete those resources or use a different stack prefix.

**CloudFormation validation error during ResourceExistenceCheck referencing CICD ARNs**

On a first deployment, IAM policy statements can reference the pipeline and ECR resources before they exist. Authorize the GitHub connection, run the pipeline and redeploy, as in [Step 4](#step-4-authorize-the-github-connection-and-build-the-images).

**Database stack fails with "Cannot find version 16.x for postgres"**

The PostgreSQL minor version is pinned in `cdk/lib/database-stack.ts` (`postgresVersion`, currently 16.15). RDS stops offering older minor versions for new instances over time. List the versions your Region offers, then set `postgresVersion` to one of them and redeploy:

```bash
aws rds describe-db-engine-versions --engine postgres --engine-version 16 \
  --query "DBEngineVersions[].EngineVersion" --output text
```

On an existing database, a higher version upgrades it in place on the next deploy (short outage, no downgrade). Run `npx cdk diff` first.

**CORS errors in the browser**

Add the page's origin to `/<STACK-PREFIX>-Api/API/AllowedOrigins` ([Adding Custom Allowed Origins](#adding-custom-allowed-origins)).

**Text generation Lambda fails with a parameter not found error**

Create the `/KC/LLM/HaikuArn` SSM parameter ([Step 2](#step-2-upload-secrets--parameters)).

**The first chat fails with `AccessDeniedException` from Bedrock**

On a new AWS account, two one-time Bedrock steps can block calls to Claude. The `lambdaTextGen` CloudWatch logs show which one:

- **Anthropic use-case form not submitted.** Anthropic requires use-case details once per account (or once for the AWS Organizations management account) before any Claude model can be called. In the Amazon Bedrock console, open **Model catalog**, select any Anthropic model and submit the form. Access is granted right after submission ([Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)).
- **AWS Marketplace subscription not created.** Claude is a third-party model, so the first call in an account starts an AWS Marketplace subscription in the background, which can take up to 15 minutes. The text generation role already has `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe` for this (`cdk/lib/api-stack.ts`). If the error says the caller is not authorized to perform the required AWS Marketplace actions, a Service Control Policy or permissions boundary in your organization is probably denying those actions; ask your AWS administrator to allow them or to subscribe to the model for the account ([Resolve AWS Marketplace permission errors](https://repost.aws/knowledge-center/bedrock-resolve-marketplace-permission)).

Amazon Titan Text Embeddings V2 is an Amazon model and needs neither step. After fixing either one, wait a few minutes and send a new message.

**Knowledge base ingestion fails or returns no results**

- Verify the `<PREFIX>-Ingestion` stack deployed successfully and both container images are in ECR.
- Check the data source's status and error message in the admin dashboard, then the `lambdaKnowledgeBase` CloudWatch logs.
- For websites and videos, check the crawler or transcriber ECS task logs in CloudWatch.
- Confirm an embedding space is active (admin dashboard → **Search index**). See [`KNOWLEDGE_BASE_DOCUMENTATION.md`](./KNOWLEDGE_BASE_DOCUMENTATION.md).

## Cleanup

### Taking down the deployed stack

Follow these steps in order, and wait for each stack to finish deleting before starting the next.

1. **Disable RDS deletion protection:** in **Amazon RDS → Databases**, select the stack's database instance, click **Modify**, clear **Deletion protection**, then **Continue** and **Modify DB instance**. Wait for the change to finish.

2. **Delete the CloudFormation stacks** in this order:
   - `<STACK-PREFIX>-EvalJobs` and `<STACK-PREFIX>-Eval` (only if deployed with `enableEval`)
   - `<STACK-PREFIX>-Cost`
   - `<STACK-PREFIX>-Amplify`
   - `<STACK-PREFIX>-Api`
   - `<STACK-PREFIX>-Ingestion` (deletes the ingest bucket and its contents)
   - `<STACK-PREFIX>-CICD`
   - `<STACK-PREFIX>-DBFlow`
   - `<STACK-PREFIX>-Database`
   - `<STACK-PREFIX>-VpcStack`

3. **Delete the secrets** in Secrets Manager: `github-personal-access-token`, `KCSecrets`, and any database credentials the stack created.

4. **Delete the SSM parameters:** `KC-owner-name`, `/KC/AllowedEmailDomains`, `/KC/LLM/HaikuArn`, `/<STACK-PREFIX>-Api/API/AllowedOrigins`.

5. **Delete the retained resources.** These survive stack deletion by design:
   - Cognito user pool `<STACK-PREFIX>-Api-UserPool`: turn off its deletion protection, then delete it.
   - KMS key described as `<STACK-PREFIX>-Api API Gateway and WAF log encryption`: schedule its deletion after the log groups below are gone.
   - CloudWatch log groups for REST API access logs, WebSocket access logs, `aws-waf-logs-<STACK-PREFIX>-Api`, and the VPC flow logs.
   - ECR repositories `<stack-prefix>-cicd-crawler` and `<stack-prefix>-cicd-transcriber` (lowercase).
   - The final RDS snapshot taken when the database was deleted (**Amazon RDS → Snapshots**), once you no longer need the data.

6. **Check for leftovers that still cost money:** RDS instances and snapshots, NAT gateways, Elastic IPs, S3 storage, and CloudWatch log groups (including the `/aws/lambda/*` groups, which keep their 90-day retention after deletion).
