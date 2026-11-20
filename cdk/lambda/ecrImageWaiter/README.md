# ECR Image Waiter Custom Resource

## Purpose

This CloudFormation custom resource stops the Ingestion stack from creating the crawler and transcriber ECS task definitions before their container images exist in ECR.

## Problem

`cdk/bin/cdk.ts` makes the Ingestion stack depend on the CICD stack (`ingestionStack.addDependency(cicdStack)`). That dependency only guarantees that the CICD stack's resources exist: the ECR repositories and the CodePipeline definition. It does not guarantee that the pipeline has run. On a first deploy, the repositories are empty until the pipeline builds and promotes an image to `latest`.

## Solution

`cdk/lib/ingestion-stack.ts` creates one waiter Lambda and two custom resources, one for each repository (`<stack-prefix>-cicd-crawler` and `<stack-prefix>-cicd-transcriber`). On Create and Update, each custom resource:

1. Checks ECR for the `latest` tag.
2. On the first miss, starts the image pipeline `<STACK-PREFIX>-CICD-DockerImagePipeline` (`TriggerBuildOnMissing: "true"`).
3. Retries every 30 seconds until the image appears or the retries run out.
4. Reports SUCCESS to CloudFormation when the image exists, or FAILED on timeout or an unexpected error. A failure rolls back the Ingestion stack.

On Delete it reports SUCCESS without doing anything.

Once both images exist, later deploys find them on the first check and continue immediately.

## Files

- `index.js`: the custom resource handler.
- `package.json`: SDK dependencies (`@aws-sdk/client-ecr`, `@aws-sdk/client-codepipeline`, `@aws-sdk/client-codebuild`).
- `cdk/lib/ingestion-stack.ts`: creates the role, the Lambda, and the two custom resources.

## Custom resource properties

| Property | Default in handler | Ingestion stack value | Description |
|---|---|---|---|
| `RepositoryName` | required | the repository name | ECR repository to check |
| `ImageTag` | required | `latest` | Tag to wait for |
| `MaxRetries` | `60` | `28` | Number of failed checks before giving up |
| `RetryDelaySeconds` | `30` | `30` | Seconds between checks |
| `TriggerBuildOnMissing` | `false` | `true` | Start a build on the first miss |
| `CodePipelineName` | none | `<STACK-PREFIX>-CICD-DockerImagePipeline` | Pipeline to start when `TriggerBuildOnMissing` is true |
| `CodeBuildProjectName` | none | not set | Used only when `CodePipelineName` is absent |

With the Ingestion stack values, each waiter gives up after about 14 minutes (28 × 30 seconds). The Lambda timeout is 15 minutes, so the waiter must finish before the Lambda is stopped. Keep `MaxRetries × RetryDelaySeconds` under 15 minutes if you change these values.

## Permissions

The waiter role (`<id>-EcrImageWaiterRole` in `ingestion-stack.ts`) has:

- `ecr:DescribeImages`, `ecr:DescribeRepositories`, `ecr:BatchGetImage` on the two repositories
- `codepipeline:StartPipelineExecution` on the image pipeline
- CloudWatch Logs write access for its own logs

## Troubleshooting

**The Ingestion stack fails after about 14 minutes with "Timeout: Image latest not found"**

The pipeline did not promote both images in time. Common causes:

1. The GitHub connection `<STACK-PREFIX>-CICD-github-conn` was not authorized, or was authorized too late.
2. A pipeline stage failed: a unit test, the Docker build, or the ECR scan gate blocking a CRITICAL or HIGH finding.

Open **CodePipeline →** `<STACK-PREFIX>-CICD-DockerImagePipeline`, fix the failing stage, and click **Release change**. When both repositories have a `latest` tag, re-run the same `cdk deploy --all` command. See [Step 4 of the Deployment Guide](../../../Docs/DEPLOYMENT_GUIDE.md#step-4-authorize-the-github-connection-and-build-the-images).

**The waiter fails immediately**

An ECR error other than "image not found" or "repository not found" (for example access denied) fails the resource straight away. Check the waiter's CloudWatch logs and the role permissions above.

**The waiter logs "Failed to start CodePipeline"**

No build was started. The waiter keeps polling and tries to start the pipeline again on the next miss. Check the `codepipeline:StartPipelineExecution` permission and the pipeline name, or start the pipeline manually.

## Monitoring

- **Logs:** the waiter Lambda's CloudWatch log group (`/aws/lambda/<function name>`, kept for 90 days) records each check, the retry count, and whether a pipeline run was started.
- **CloudFormation events:** in the Ingestion stack, the resources whose logical IDs contain `EcrImageWaiterCrawler` and `EcrImageWaiterTranscriber` stay in `CREATE_IN_PROGRESS` while waiting.

For the full pipeline, see [CICD_PIPELINE.md](../../../Docs/CICD_PIPELINE.md).
