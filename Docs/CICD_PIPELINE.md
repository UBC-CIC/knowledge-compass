# CI/CD Pipeline

This document describes how code changes reach a deployed Knowledge Compass environment. It covers what runs automatically on a push, what still needs a manual `cdk deploy`, and how to operate and change the pipeline.

The source of truth is the CDK code. When this document and the code disagree, the code wins:

| Concern | Source |
|---|---|
| Container pipeline, ECR repositories, scan gate | `cdk/lib/cicd-stack.ts` |
| Pipeline wiring (images built, branch, environment) | `cdk/bin/cdk.ts` (`CICDStack` props) |
| Waiting for images on first deploy | `cdk/lib/ingestion-stack.ts`, `cdk/lambda/ecrImageWaiter/index.js` |
| Frontend pipeline, deploy script, and hosting | `cdk/lib/amplify-stack.ts` |
| CodeBuild log retention | `cdk/lib/log-retention.ts` |
| Pipeline contract tests | `cdk/test/cicd-stack.test.ts` |

## Overview

There are two independent automated delivery paths and one manual path.

| What changes | How it is delivered | Trigger |
|---|---|---|
| Crawler and transcriber container images (`cdk/containers/`) | CodePipeline `<STACK-PREFIX>-CICD-DockerImagePipeline`: unit tests, then image build, scan, and push to ECR | Every push to the configured branch |
| Frontend (`frontend/`) | CodePipeline `<STACK-PREFIX>-Amplify-FrontendPipeline`: lint, unit tests, production build, then a manual deployment to Amplify Hosting | Every push to the configured branch that changes a file under `frontend/` |
| Infrastructure, Lambda handlers (Node.js and Python), database migrations, the pipeline itself | `npx cdk deploy --all` run by an operator | Manual |

The CodePipeline runs the full backend test suite, but it does not deploy Lambda code or CloudFormation changes. A change to `cdk/lambda/` or `cdk/lib/` is live only after someone runs `cdk deploy`. See [Deploy the stacks](./DEPLOYMENT_GUIDE.md#deploy-the-stacks) for the command and context values.

## Container image pipeline

The `<STACK-PREFIX>-CICD` stack creates one CodePipeline with three stages that run in order. A failure in any stage stops the run.

```
GitHub push ──► Source ──► Test (UnitTests) ──► Build (Build_crawler ‖ Build_transcriber) ──► ECR :latest
```

### Source stage

- Uses an AWS CodeConnections GitHub connection named `<STACK-PREFIX>-CICD-github-conn`. The connection must be authorized once in the console after the first deploy (see [Step 4 of the Deployment Guide](./DEPLOYMENT_GUIDE.md#step-4-authorize-the-github-connection-and-build-the-images)).
- The repository owner comes from the SSM parameter `KC-owner-name`. The repository name comes from the `githubRepo` context value.
- The branch is the `githubBranch` context value, which defaults to `main`.
- `triggerOnPush` is on, so every push to that branch starts a run, whatever files changed.

### Test stage

The CodeBuild project `<STACK-PREFIX>-CICD-UnitTests` gates the image builds. It runs on the `STANDARD_7_0` image with Node.js 22 and Python 3.12, has a 20-minute timeout, and has no AWS permissions beyond the CodeBuild defaults for logs and artifacts. Tests must therefore be hermetic.

It installs a pinned `boto3` (version set in `cdk/lib/cicd-stack.ts`) and runs, from the repository root:

1. `cdk`: `npm ci`, then `npx tsc --noEmit`
2. `cdk`: `npx jest --ci` (CDK contract tests in `cdk/test/`)
3. `cdk`: `npm run test:lambda` (Node.js handler tests, `lambda/**/tests/*.test.js`)
4. `cdk/lambda/textGeneration`: `python -m unittest discover -s tests`
5. `cdk/lambda/knowledgeBase`: `python -m unittest discover -s tests`
6. `cdk`: `python -m unittest discover -s containers/tests` (crawler and transcriber tests, with heavy dependencies stubbed)

Frontend tests do not run here. They run in the frontend pipeline.

### Build stage

One CodeBuild project per image runs in parallel: `<STACK-PREFIX>-CICD-crawlerBuilder` and `<STACK-PREFIX>-CICD-transcriberBuilder`. Both run in privileged mode so they can use Docker.

| Image | Build context | Dockerfile | ECR repository |
|---|---|---|---|
| crawler | `cdk/containers` | `cdk/containers/crawler/Dockerfile` | `<stack-prefix>-cicd-crawler` |
| transcriber | `cdk/containers` | `cdk/containers/transcriber/Dockerfile` | `<stack-prefix>-cicd-transcriber` |

The build context is `cdk/containers` so the shared `common/` package is available to both images.

Each build:

1. Logs in to ECR.
2. Tags the image `<module>-<environment>-<7-char commit>-<build number>`, for example `crawler-dev-f512a58-42`. This is the candidate tag.
3. Runs `docker build`.
4. Runs the ECR scan gate (next section). The gate decides whether the candidate becomes `latest`.

### ECR vulnerability scan gate

The gate is `ECR_SCAN_GATE_SCRIPT` in `cdk/lib/cicd-stack.ts`. It runs in the build's `post_build` phase and fails closed.

1. If the Docker build failed, it exits without pushing anything.
2. It pushes only the candidate tag. ECR scan-on-push starts a basic scan.
3. It polls the scan status every 10 seconds, up to 60 times (about 10 minutes). A lookup error, a `FAILED` or unsupported status, or a timeout blocks the image.
4. It counts CRITICAL and HIGH findings. Any finding whose name is not in `ECR_SCAN_ALLOWED_FINDINGS` blocks the image, and the build log prints a table of the blocking findings with package names and versions.
5. If nothing blocks, it retags the scanned digest as `latest` with `ecr put-image` and checks that `latest` now points to that digest.
6. It then tries `lambda update-function-code` for the configured function name. The crawler and transcriber are ECS tasks, not Lambdas, so the function does not exist and this step is skipped.

A blocked image never touches `latest`, so the running environment keeps the last good image.

The ECS task definitions in the Ingestion stack reference `:latest`. Each new crawler or transcriber task pulls the image `latest` points to at launch, so a promoted image is used by the next ingestion run without a redeploy.

#### Accepting a scan finding

Prefer a newer base image or package version. If no fix exists yet, add an entry to `ECR_SCAN_ALLOWED_FINDINGS` in `cdk/lib/cicd-stack.ts`:

- The key is the finding name exactly as ECR reports it (the CVE id). Names may only contain letters, digits, `.`, `_`, `:`, and `-`.
- The value must state the affected package and image, why the risk is accepted, the date accepted, and a review date.
- The allow-list applies to every image the pipeline builds.
- Remove the entry once a fix ships.

Allow-list changes are part of the CICD stack's buildspec, so they take effect only after `npx cdk deploy <STACK-PREFIX>-CICD` (or `--all`). After deploying, start the pipeline again with **Release change**.

### ECR repositories

- Tags are mutable, because the gate retags the candidate as `latest`.
- Scan on push is on.
- Lifecycle rules keep the one `latest` image and the 30 most recent candidate tags, and expire untagged images after 14 days.
- The removal policy is `RETAIN`. Deleting the stack leaves the repositories behind (see [Taking down the deployed stack](./DEPLOYMENT_GUIDE.md#taking-down-the-deployed-stack)).
- A repository policy lets the Lambda service in the same account pull images.
- Encryption is the ECR default (AES-256). See [AWS_MANAGED_KEYS.md](./AWS_MANAGED_KEYS.md) for switching to a customer-managed key.

### Artifacts and logs

- Pipeline artifacts go to an S3 bucket with public access blocked, TLS enforced, and server access logs written to a second bucket. Both use SSE-S3 encryption and are destroyed with the stack.
- CodeBuild logs go to `/aws/codebuild/<project-name>` and are kept for 90 days (`SERVICE_LOG_RETENTION`).

### Permissions

| Role | Grants |
|---|---|
| Image builder role (`DockerBuildRole`) | Push, describe, read scan findings, and `PutImage` on the two pipeline repositories only; `ecr:GetAuthorizationToken` (no resource-level scoping exists); `lambda:GetFunction`/`UpdateFunctionCode`/`UpdateFunctionConfiguration` on the two configured function names |
| Unit test project role | CDK defaults only (logs and pipeline artifacts) |
| Image waiter role (Ingestion stack) | `ecr:DescribeImages`/`DescribeRepositories`/`BatchGetImage` on the two repositories; `codepipeline:StartPipelineExecution` on this pipeline |
| Frontend source action role (Amplify stack) | `codeconnections:UseConnection` and `codestar-connections:UseConnection` on the GitHub connection (the IAM prefix must match the connection ARN's prefix) |
| Frontend build project role (Amplify stack) | CDK defaults only (logs and pipeline artifacts) |
| Frontend deploy project role (Amplify stack) | `amplify:GetApp` on the app; `amplify:CreateDeployment`/`StartDeployment`/`GetJob` on the deployment branch and its jobs |

`cdk/test/cicd-stack.test.ts` asserts the ECR scoping, so a change that widens it fails the Test stage.

## First deployment and the image waiter

On a first `cdk deploy --all`, the CICD stack is created before the images exist. The Ingestion stack depends on the CICD stack and contains one `EcrImageWaiter` custom resource per repository. Each waiter:

1. Checks ECR for the `latest` tag.
2. On the first miss, starts the pipeline (`TriggerBuildOnMissing`).
3. Retries every 30 seconds, 28 times (about 14 minutes), then fails the Ingestion stack.

This is why the GitHub connection must be authorized within about 14 minutes of the CICD stack finishing. If the waiter times out, fix the pipeline and re-run the same deploy command, as described in [Step 4 of the Deployment Guide](./DEPLOYMENT_GUIDE.md#step-4-authorize-the-github-connection-and-build-the-images). Once both images exist, later deploys pass the waiter immediately.

See `cdk/lambda/ecrImageWaiter/README.md` for the waiter's properties, permissions, and troubleshooting.

## Frontend pipeline (Amplify Hosting)

The `<STACK-PREFIX>-Amplify` stack creates an Amplify app with no repository connection and a CodePipeline that builds the frontend and deploys it to that app. No GitHub token is involved: the pipeline reads the repository through the CICD stack's CodeConnections connection, `<STACK-PREFIX>-CICD-github-conn`.

```
GitHub push touching frontend/ ──► Source ──► Build (LintTestBuild) ──► Deploy (AmplifyDeploy) ──► Amplify branch
```

- **Trigger:** a V2 pipeline trigger on the `githubBranch` branch (default `main`) with the file path filter `frontend/**`. Pushes that change nothing under `frontend/` do not start it. CloudFormation starts one run when the pipeline is created.
- **Build stage:** the CodeBuild project `<STACK-PREFIX>-Amplify-FrontendBuild` runs on `STANDARD_7_0` with Node.js 24: `npm ci`, `npm run lint`, `npm test`, `npm run build` in `frontend/`. Its output artifact is the contents of `frontend/dist`. The project has no AWS permissions beyond the CodeBuild defaults, so the npm dependencies never run with deploy rights.
- **Environment:** the build project receives the `VITE_*` values (Region, Cognito pool and client IDs, identity pool, REST and WebSocket endpoints) from the API stack. Changing them requires `cdk deploy` of the Amplify stack, then a new pipeline run.
- **Deploy stage:** the CodeBuild project `<STACK-PREFIX>-Amplify-FrontendDeploy` runs `FRONTEND_DEPLOY_SCRIPT` from `cdk/lib/amplify-stack.ts`. It refuses to deploy if the Amplify app is still connected to a repository or the artifact has no `index.html`. It then zips the artifact, calls `amplify create-deployment`, uploads the zip to the returned presigned URL (never printed), calls `amplify start-deployment`, and polls `amplify get-job` every 10 seconds for up to 15 minutes. Any status other than `SUCCEED` fails the stage.
- **Branches:** the Amplify branch `main` always exists, and so does `githubBranch` when it is another branch. Only `githubBranch` receives deployments. Auto build and pull request previews are off on both.
- **Response headers:** security headers (including the CSP) are set on the Amplify app in the single-app `customHeaders` format and apply from the next deployment of the branch.

A lint error, failing frontend test, or failed deployment stops the pipeline, and the previous deployment keeps serving.

### Moving an existing deployment off the GitHub token

Deployments created before this pipeline have an Amplify app that builds from GitHub with the `github-personal-access-token` secret. Deploying the Amplify stack updates that app in place, so its app ID and URL stay the same. After `npx cdk deploy <STACK-PREFIX>-Amplify`:

1. Check the app no longer has a repository. The command should print `None` or nothing:

   ```bash
   aws amplify get-app --app-id <APP-ID> --query app.repository --output text --profile <YOUR-PROFILE-NAME>
   ```

   If it still prints the repository URL, the app kept its connection and the Deploy stage fails with "still connected". The site keeps serving its last build. Amplify accepts manual deployments only once the connection is gone. Replacing the app removes it but gives the app a new ID and URL, which also needs the AllowedOrigins parameter, the gateway origin, and the ingest bucket CORS updated, so plan that as a separate change.
2. Wait for `<STACK-PREFIX>-Amplify-FrontendPipeline` to succeed, then check the security headers are served:

   ```bash
   curl -sI https://<githubBranch>.<APP-ID>.amplifyapp.com | grep -i content-security-policy
   ```

3. Delete the `github-personal-access-token` secret, and revoke the token in GitHub.

## Running and troubleshooting the pipeline

| Task | How |
|---|---|
| Re-run the latest commit | **CodePipeline → Pipelines →** `<STACK-PREFIX>-CICD-DockerImagePipeline` **→ Release change** |
| See why a stage failed | Open the red stage, **View details**, then the CodeBuild log link |
| Confirm a promoted image | **Amazon ECR →** `<stack-prefix>-cicd-crawler` / `-transcriber`: `latest` and the newest candidate tag share one digest |
| Re-run a frontend build and deploy | **CodePipeline → Pipelines →** `<STACK-PREFIX>-Amplify-FrontendPipeline` **→ Release change** |

Common failures:

- **Source stage fails:** the GitHub connection is not **Available**, or the connection was not granted access to the repository.
- **Test stage fails:** a test or the TypeScript check failed. Reproduce locally with the commands in [Test stage](#test-stage).
- **Build stage fails at the scan gate:** the log names each blocking CVE with its package. Update the base image or package, or add a justified allow-list entry (see [Accepting a scan finding](#accepting-a-scan-finding)).
- **Build stage fails at `pip install --require-hashes`:** a container dependency changed without regenerating its lock. See [DEPENDENCY_MANAGEMENT.MD](./DEPENDENCY_MANAGEMENT.MD).

## Changing the pipeline

- Edit `cdk/lib/cicd-stack.ts` (or the `CICDStack` props in `cdk/bin/cdk.ts`), never the generated `.js`/`.d.ts` siblings.
- Update `cdk/test/cicd-stack.test.ts` when stage order, permissions, the buildspec, or the scan gate change. The tests run the shipped gate script against stubbed AWS CLI responses.
- Deploy with `npx cdk deploy <STACK-PREFIX>-CICD` using the same context values as the original deploy. The pipeline does not update itself.
- To build another image, add an entry to the `lambdaFunctions` array in `cdk/bin/cdk.ts`. This creates its repository, builder project, and Build-stage action.

## Known behavior and gaps

- **Every push rebuilds both images.** The builders contain a path check meant to skip an image when its source directory did not change. The source stage outputs a zip without `.git` history, so the check always falls through to "build to be safe". The `pathFilters` prop passed in `cdk/bin/cdk.ts` is not read by the stack. If the path check is ever activated (for example by switching the source action to a full clone), note that a skipped image exits with status 1, which marks the Build stage as failed.
- **No automated infrastructure or Lambda deployment.** Backend code and CloudFormation changes need a manual `cdk deploy`.
- **No promotion between environments.** Each deployment (one `StackPrefix`) has its own pipeline watching the branch set by `githubBranch`. There is no approval stage and no path from one environment to another.
- **Frontend and container paths are not coordinated.** A push can deploy a new frontend while the container pipeline fails, or the reverse.
- **Only `githubBranch` gets frontend deployments.** When `githubBranch` is not `main`, the Amplify `main` branch still exists but no pipeline deploys to it.
- **Frontend pipeline changes need a deploy.** Like the container pipeline, it does not update itself: changes to `cdk/lib/amplify-stack.ts` take effect after `npx cdk deploy <STACK-PREFIX>-Amplify`.
