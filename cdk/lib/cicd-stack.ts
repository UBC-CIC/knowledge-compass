import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as codeconnections from "aws-cdk-lib/aws-codeconnections";
import * as s3 from "aws-cdk-lib/aws-s3";

interface LambdaConfig {
  name: string; // Module name (e.g., "textGeneration")
  functionName: string; // Lambda function name
  sourceDir: string; // Path used for path-filter change detection AND default Dockerfile location
  // Optional Docker build context (relative to repo root). Defaults to sourceDir.
  // Use this when the Dockerfile needs files outside sourceDir (e.g. the shared
  // "cdk/containers/common" package for the crawler/transcriber images).
  buildContext?: string;
  // Optional Dockerfile path (relative to repo root). Defaults to sourceDir/Dockerfile.
  dockerfile?: string;
}

interface CICDStackProps extends cdk.StackProps {
  githubRepo: string;
  githubBranch?: string;
  environmentName?: string;
  lambdaFunctions: LambdaConfig[];
  pathFilters?: string[];
}

// ECR vulnerability scan gate, run as the image builders' post_build step.
// Pushes only the unique candidate tag, waits for the scan-on-push result
// (fail closed on errors, FAILED/unsupported status, or timeout), blocks on
// any CRITICAL or HIGH finding not on ECR_SCAN_ALLOWED_FINDINGS (A-09), and
// only then retags the scanned manifest as
// `latest` (by digest) and updates the Lambda. A failing image never touches
// `latest`. Embedded base64-encoded in the buildspec to avoid YAML/quoting
// issues; exported so tests can run the exact shipped script.
// CRITICAL/HIGH findings the scan gate accepts, keyed by finding name (the CVE id
// ECR basic scanning reports) with the reason it is accepted and a review date.
// Add an entry only when no fixed base image or package exists yet, and remove
// it once one does. Applies to every image the pipeline builds.
export const ECR_SCAN_ALLOWED_FINDINGS: Record<string, string> = {
  "CVE-2026-5435":
    "glibc 2.41-12+deb13u4 (transcriber, python:3.12-slim / Debian 13): no trixie fix; Debian marks it no-dsa (minor). " +
    "Out-of-bounds write in the deprecated libresolv ns_printrr/ns_printrrf/fp_nquery debug printers, which no image code calls. " +
    "Accepted 2026-11-19; review by 2027-01-19 or when trixie ships a fixed glibc.",
  "CVE-2026-19499":
    "glibc 2.41-12+deb13u4 (transcriber, python:3.12-slim / Debian 13): no trixie fix; Debian marks it no-dsa (minor). " +
    "Overflow in strfmon/strfmon_l right-justified padding, which no image code calls. " +
    "Accepted 2026-11-19; review by 2027-01-19 or when trixie ships a fixed glibc.",
};

// The space-separated SCAN_ALLOWED_FINDINGS value for the gate. Names are
// restricted so they can go on the buildspec command line unquoted-safe.
export function scanAllowListEnv(allowed: Record<string, string>): string {
  for (const [name, reason] of Object.entries(allowed)) {
    if (!/^[A-Za-z0-9._:-]+$/.test(name)) {
      throw new Error(`Invalid ECR scan allow-list entry '${name}'`);
    }
    if (!reason.trim()) {
      throw new Error(`ECR scan allow-list entry ${name} needs a reason`);
    }
  }
  return Object.keys(allowed).join(" ");
}

export const ECR_SCAN_GATE_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
: "\${REPO_NAME:?}" "\${REPOSITORY_URI:?}" "\${IMAGE_TAG:?}" "\${LAMBDA_FUNCTION_NAME:?}"

if [ "\${CODEBUILD_BUILD_SUCCEEDING:-1}" != "1" ]; then
  echo "Build phase failed; not pushing or promoting the image."
  exit 1
fi

MAX_ATTEMPTS="\${SCAN_MAX_ATTEMPTS:-60}"
INTERVAL="\${SCAN_POLL_INTERVAL:-10}"

echo "Pushing candidate image $REPOSITORY_URI:$IMAGE_TAG"
docker push "$REPOSITORY_URI:$IMAGE_TAG"

DIGEST=$(aws ecr describe-images --repository-name "$REPO_NAME" --image-ids imageTag="$IMAGE_TAG" \\
  --query 'imageDetails[0].imageDigest' --output text)
if [ -z "$DIGEST" ] || [ "$DIGEST" = "None" ]; then
  echo "Could not resolve digest for $IMAGE_TAG. Blocking deployment."
  exit 1
fi

echo "Waiting for vulnerability scan of $IMAGE_TAG ($DIGEST)..."
attempt=0
while :; do
  attempt=$((attempt + 1))
  # --no-paginate: while a scan is in progress the response has no
  # imageScanFindings, and the CLI paginator crashes merging its result keys
  # ("'NoneType' object does not support item assignment").
  if OUT=$(aws ecr describe-image-scan-findings --repository-name "$REPO_NAME" --image-id imageDigest="$DIGEST" \\
        --no-paginate --query 'imageScanStatus.status' --output text 2>&1); then
    STATUS="$OUT"
  elif printf '%s' "$OUT" | grep -q ScanNotFoundException; then
    STATUS="NOT_STARTED"
  else
    echo "Scan status lookup failed: $OUT. Blocking deployment."
    exit 1
  fi
  case "$STATUS" in
    COMPLETE|ACTIVE) break ;;
    IN_PROGRESS|PENDING|NOT_STARTED) ;;
    *) echo "Scan finished with status $STATUS. Blocking deployment."; exit 1 ;;
  esac
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "Timed out waiting for scan (last status: $STATUS). Blocking deployment."
    exit 1
  fi
  sleep "$INTERVAL"
done

# CRITICAL and HIGH findings block promotion unless their name is on the
# allow-list (SCAN_ALLOWED_FINDINGS, space-separated; see ECR_SCAN_ALLOWED_FINDINGS).
COUNTS=$(aws ecr describe-image-scan-findings --repository-name "$REPO_NAME" --image-id imageDigest="$DIGEST" \
  --no-paginate --query '[imageScanFindings.findingSeverityCounts.CRITICAL, imageScanFindings.findingSeverityCounts.HIGH]' \
  --output text)
read -r CRITICAL HIGH _ <<< "$COUNTS" || true
for SEV in CRITICAL HIGH; do
  N="\${!SEV:-None}"
  if [ "$N" = "None" ]; then
    N=0
  fi
  if ! [[ "$N" =~ ^[0-9]+$ ]]; then
    echo "Unexpected $SEV count '$N'. Blocking deployment."
    exit 1
  fi
  printf -v "$SEV" '%s' "$N"
done

if [ $((CRITICAL + HIGH)) -gt 0 ]; then
  NAMES=$(aws ecr describe-image-scan-findings --repository-name "$REPO_NAME" --image-id imageDigest="$DIGEST" \
    --query "imageScanFindings.findings[?severity=='CRITICAL' || severity=='HIGH'].name" --output text)
  LISTED=0
  BLOCKING=""
  for NAME in $NAMES; do
    if [ "$NAME" = "None" ]; then
      continue
    fi
    LISTED=$((LISTED + 1))
    case " \${SCAN_ALLOWED_FINDINGS:-} " in
      *" $NAME "*) echo "Allow-listed finding: $NAME" ;;
      *) BLOCKING="$BLOCKING $NAME" ;;
    esac
  done
  if [ "$LISTED" -eq 0 ]; then
    echo "Scan reports CRITICAL: $CRITICAL, HIGH: $HIGH but no findings could be listed. Blocking deployment."
    exit 1
  fi
  if [ -n "$BLOCKING" ]; then
    echo "Blocking vulnerabilities found (CRITICAL: $CRITICAL, HIGH: $HIGH):$BLOCKING. Blocking deployment; latest left unchanged."
    aws ecr describe-image-scan-findings --repository-name "$REPO_NAME" --image-id imageDigest="$DIGEST" \
      --query "imageScanFindings.findings[?severity=='CRITICAL' || severity=='HIGH'].[severity, name, attributes[?key=='package_name'].value | [0], attributes[?key=='package_version'].value | [0]]" \
      --output table || true
    exit 1
  fi
  echo "Every CRITICAL/HIGH finding is allow-listed. Promoting $IMAGE_TAG to latest."
else
  echo "No CRITICAL or HIGH vulnerabilities found. Promoting $IMAGE_TAG to latest."
fi

CURRENT=$(aws ecr describe-images --repository-name "$REPO_NAME" --image-ids imageTag=latest \\
  --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || echo "NONE")
if [ "$CURRENT" != "$DIGEST" ]; then
  MEDIA_TYPES="application/vnd.docker.distribution.manifest.v2+json application/vnd.oci.image.manifest.v1+json application/vnd.docker.distribution.manifest.list.v2+json application/vnd.oci.image.index.v1+json"
  MANIFEST=$(aws ecr batch-get-image --repository-name "$REPO_NAME" --image-ids imageDigest="$DIGEST" \\
    --accepted-media-types $MEDIA_TYPES --query 'images[0].imageManifest' --output text)
  MEDIA_TYPE=$(aws ecr batch-get-image --repository-name "$REPO_NAME" --image-ids imageDigest="$DIGEST" \\
    --accepted-media-types $MEDIA_TYPES --query 'images[0].imageManifestMediaType' --output text)
  if [ -z "$MANIFEST" ] || [ "$MANIFEST" = "None" ]; then
    echo "Could not read manifest for $DIGEST. Blocking deployment."
    exit 1
  fi
  aws ecr put-image --repository-name "$REPO_NAME" --image-tag latest --image-manifest "$MANIFEST" \\
    --image-manifest-media-type "$MEDIA_TYPE" --image-digest "$DIGEST" >/dev/null
fi
PROMOTED=$(aws ecr describe-images --repository-name "$REPO_NAME" --image-ids imageTag=latest \\
  --query 'imageDetails[0].imageDigest' --output text)
if [ "$PROMOTED" != "$DIGEST" ]; then
  echo "latest ($PROMOTED) does not match candidate ($DIGEST). Failing."
  exit 1
fi
echo "latest now points to $DIGEST"

if aws lambda get-function --function-name "$LAMBDA_FUNCTION_NAME" >/dev/null 2>&1; then
  echo "Updating Lambda function to use the new image..."
  aws lambda update-function-code --function-name "$LAMBDA_FUNCTION_NAME" --image-uri "$REPOSITORY_URI@$DIGEST"
else
  echo "Lambda function $LAMBDA_FUNCTION_NAME does not exist yet. Skipping update."
fi
`;

export class CICDStack extends cdk.Stack {
  public readonly ecrRepositories: { [key: string]: ecr.Repository } = {};
  public readonly buildProjects: { [key: string]: codebuild.IProject } = {};
  public readonly pipelineName: string;
  /** GitHub connection ARN; the Amplify stack's frontend pipeline uses it too. */
  public readonly githubConnectionArn: string;

  constructor(scope: Construct, id: string, props: CICDStackProps) {
    super(scope, id, props);

    const envName = props.environmentName ?? "dev";
    this.pipelineName = `${id}-DockerImagePipeline`;

    // Create a common role for all CodeBuild projects
    const codeBuildRole = new iam.Role(this, "DockerBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    const lambdaUpdateArns = props.lambdaFunctions.map(
      (fn) => `arn:aws:lambda:${this.region}:${this.account}:function:${fn.functionName}`
    );

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "lambda:GetFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
        ],
        resources: lambdaUpdateArns,
      })
    );

    // ECR access is limited to this pipeline's own repositories (finding
    // f-f3a99fb0: the AmazonEC2ContainerRegistryPowerUser managed policy used
    // to grant push/overwrite/delete on every repository in the account).
    // Builds push here and the scan gate reads scan results and retags the
    // scanned candidate as `latest`. Base images come from public registries.
    const ecrRepoArns = props.lambdaFunctions.map(
      (fn) => `arn:aws:ecr:${this.region}:${this.account}:repository/${id.toLowerCase()}-${fn.name.toLowerCase()}`
    );

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          // docker push
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:GetDownloadUrlForLayer",
          // scan gate
          "ecr:DescribeImages",
          "ecr:DescribeImageScanFindings",
          "ecr:BatchGetImage",
          "ecr:PutImage",
        ],
        resources: ecrRepoArns,
      })
    );
    // `docker login`: GetAuthorizationToken has no resource-level permissions.
    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      })
    );

    // Create artifacts for pipeline
    const sourceOutput = new codepipeline.Artifact();

    // Explicit artifact bucket with access logging
    const artifactAccessLogsBucket = new s3.Bucket(this, "ArtifactAccessLogs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true,
    });

    const artifactBucket = new s3.Bucket(this, "PipelineArtifactBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true,
      serverAccessLogsBucket: artifactAccessLogsBucket,
      serverAccessLogsPrefix: "pipeline-artifacts/",
    });

    // Create the pipeline
    const pipeline = new codepipeline.Pipeline(this, "DockerImagePipeline", {
      pipelineName: this.pipelineName,
      artifactBucket: artifactBucket,
    });

    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "KC-owner-name"
    );

    // Create GitHub connection using CodeStar Connections
    // Note: logical ID bumped to GitHubConnectionV2 because the previous
    // connection (GitHubConnection) was deleted outside of CloudFormation,
    // leaving the stack pointing at a physical ARN that no longer exists.
    //
    // GitHubConnectionV2 was authorized against a personal account's
    // AWS Connector installation, and a connection cannot move to another
    // installation. The pipelines now use GitHubConnectionV3, authorized
    // against the repository owner's organization installation (a repo admin
    // or org owner must complete the authorization). V2 and its export stay
    // until the Amplify stack no longer imports it; remove both afterwards.
    const legacyGithubConnection = new codeconnections.CfnConnection(
      this,
      "GitHubConnectionV2",
      {
        connectionName: `${id}-github-conn`,
        providerType: "GitHub",
      }
    );
    this.exportValue(legacyGithubConnection.attrConnectionArn);

    const githubConnection = new codeconnections.CfnConnection(
      this,
      "GitHubConnectionV3",
      {
        // Connection names are unique per account, so V3 cannot reuse V2's name.
        connectionName: `${id}-github-org-conn`,
        providerType: "GitHub",
      }
    );
    this.githubConnectionArn = githubConnection.attrConnectionArn;

    // Output the connection ARN for reference
    new cdk.CfnOutput(this, "GitHubConnectionArn", {
      value: githubConnection.attrConnectionArn,
      description: "ARN of the GitHub connection. After deployment, authorize this connection in the AWS Console.",
    });

    // Add source stage using CodeStar Connections
    pipeline.addStage({
      stageName: "Source",
      actions: [
        new codepipeline_actions.CodeStarConnectionsSourceAction({
          actionName: "GitHub",
          owner: username,
          repo: props.githubRepo,
          branch: props.githubBranch ?? "main",
          connectionArn: githubConnection.attrConnectionArn,
          output: sourceOutput,
          triggerOnPush: true,
        }),
      ],
    });

    // Unit tests gate the image builds: a failing test stops the pipeline
    // before any container image is built or pushed. Runs without AWS access
    // (the project role only gets the defaults CodeBuild needs for logs and
    // pipeline artifacts), so tests must stay hermetic.
    const unitTestProject = new codebuild.PipelineProject(this, "UnitTestProject", {
      projectName: `${id}-UnitTests`,
      description: "CDK contract tests, Node.js handler tests, and Python Lambda unit tests",
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      timeout: cdk.Duration.minutes(20),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": { nodejs: "22", python: "3.12" },
            commands: [
              // boto3 is provided by the Lambda runtime; tests import it but
              // stub every client call.
              "pip install --quiet boto3==1.43.42",
            ],
          },
          build: {
            commands: [
              "cd $CODEBUILD_SRC_DIR/cdk && npm ci",
              "cd $CODEBUILD_SRC_DIR/cdk && npx tsc --noEmit",
              "cd $CODEBUILD_SRC_DIR/cdk && npx jest --ci",
              "cd $CODEBUILD_SRC_DIR/cdk && npm run test:lambda",
              "cd $CODEBUILD_SRC_DIR/cdk/lambda/textGeneration && PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests",
              "cd $CODEBUILD_SRC_DIR/cdk/lambda/knowledgeBase && PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests",
              // Crawler/transcriber code and its parity with the Lambda copy of
              // url_safety.py; heavy dependencies are stubbed, so no extra installs.
              "cd $CODEBUILD_SRC_DIR/cdk && PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s containers/tests",
            ],
          },
        },
      }),
    });

    pipeline.addStage({
      stageName: "Test",
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: "UnitTests",
          project: unitTestProject,
          input: sourceOutput,
        }),
      ],
    });

    // Create build actions for each Lambda function
    const buildActions: codepipeline_actions.CodeBuildAction[] = [];

    props.lambdaFunctions.forEach((lambda) => {
      // Create ECR repository
      const repoName = `${id.toLowerCase()}-${lambda.name.toLowerCase()}`;
      const ecrRepo = new ecr.Repository(this, `${lambda.name}Repo`, {
        repositoryName: repoName,
        // MUTABLE is required: the scan gate retags the scanned candidate as latest
        imageTagMutability: ecr.TagMutability.MUTABLE,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        imageScanOnPush: true,
        lifecycleRules: [
          {
            rulePriority: 1,
            description: "Keep the promoted latest image",
            tagStatus: ecr.TagStatus.TAGGED,
            tagPrefixList: ["latest"],
            maxImageCount: 1,
          },
          {
            rulePriority: 2,
            description: "Keep the 30 most recent candidate images",
            tagStatus: ecr.TagStatus.TAGGED,
            tagPrefixList: [`${lambda.name}-${envName}-`],
            maxImageCount: 30,
          },
          {
            rulePriority: 3,
            description: "Expire untagged images after 14 days",
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: cdk.Duration.days(14),
          },
        ],
      });

      ecrRepo.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "LambdaPullAccess",
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
          actions: [
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
            "ecr:BatchCheckLayerAvailability",
          ],
          conditions: {
            StringEquals: {
              "aws:SourceAccount": this.account,
            },
          },
        })
      );

      this.ecrRepositories[lambda.name] = ecrRepo;
      cdk.Tags.of(ecrRepo).add("module", lambda.name);
      cdk.Tags.of(ecrRepo).add("env", envName);

      // Create CodeBuild project
      const buildProject = new codebuild.PipelineProject(
        this,
        `${lambda.name}BuildProject`,
        {
          projectName: `${id}-${lambda.name}Builder`,
          role: codeBuildRole,
          environment: {
            buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
            privileged: true,
          },
          environmentVariables: {
            AWS_ACCOUNT_ID: { value: this.account },
            AWS_REGION: { value: this.region },
            ENVIRONMENT: { value: envName },
            MODULE_NAME: { value: lambda.name },
            LAMBDA_FUNCTION_NAME: { value: lambda.functionName },
            REPO_NAME: { value: repoName },
            REPOSITORY_URI: { value: ecrRepo.repositoryUri },
            GITHUB_USERNAME: { value: username },
            GITHUB_REPO: { value: props.githubRepo },
            PATH_FILTER: { value: lambda.sourceDir },
          },
          buildSpec: codebuild.BuildSpec.fromObject({
            version: "0.2",
            phases: {
              pre_build: {
                commands: [
                  "echo Logging in to Amazon ECR...",
                  "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com",
                  'echo "#!/bin/bash" > check_and_build.sh',
                  'echo "set -e" >> check_and_build.sh',
                  'echo "# Source is provided by CodePipeline via CodeStar Connection" >> check_and_build.sh',
                  'echo "cd $CODEBUILD_SRC_DIR" >> check_and_build.sh',
                  'echo "# Check if image exists in ECR" >> check_and_build.sh',
                  'echo "if ! aws ecr describe-images --repository-name $REPO_NAME --image-ids imageTag=latest &>/dev/null; then" >> check_and_build.sh',
                  'echo "  echo \\\"First deployment or image doesn\'t exist - building without path check\\\"" >> check_and_build.sh',
                  'echo "  exit 0" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  'echo "# Initialize git if needed (CodePipeline source may not have .git)" >> check_and_build.sh',
                  'echo "if [ ! -d .git ]; then" >> check_and_build.sh',
                  'echo "  echo \\\"No git history available - building to be safe\\\"" >> check_and_build.sh',
                  'echo "  exit 0" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  'echo "PREV_COMMIT=\\$(git rev-parse HEAD~1 || echo \\\"\\\")" >> check_and_build.sh',
                  'echo "if [ -z \\\"\\$PREV_COMMIT\\\" ]; then" >> check_and_build.sh',
                  'echo "  echo \\\"First commit - building\\\"" >> check_and_build.sh',
                  'echo "  exit 0" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  'echo "CHANGED_FILES=\\$(git diff --name-only \\$PREV_COMMIT HEAD)" >> check_and_build.sh',
                  'echo "echo \\\"Changed files:\\\"" >> check_and_build.sh',
                  'echo "echo \\\"\\$CHANGED_FILES\\\"" >> check_and_build.sh',
                  'echo "if ! echo \\\"\\$CHANGED_FILES\\\" | grep -q \\\"^$PATH_FILTER/\\\"; then" >> check_and_build.sh',
                  'echo "  echo \\\"No changes in $PATH_FILTER — skipping build.\\\"" >> check_and_build.sh',
                  'echo "  exit 1" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  'echo "exit 0" >> check_and_build.sh',
                  "chmod +x check_and_build.sh",
                  "COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)",
                  "export IMAGE_TAG=${MODULE_NAME}-${ENVIRONMENT}-${COMMIT_HASH}-${CODEBUILD_BUILD_NUMBER}",
                  "export DOCKER_HOST=unix:///var/run/docker.sock",
                  './check_and_build.sh || { echo "Skipping build due to no changes"; exit 1; }',
                ],
              },
              build: {
                commands: [
                  'echo "Building Docker image..."',
                  `docker build -t $REPOSITORY_URI:$IMAGE_TAG "$CODEBUILD_SRC_DIR/${lambda.buildContext ?? lambda.sourceDir}" -f "$CODEBUILD_SRC_DIR/${lambda.dockerfile ?? `${lambda.sourceDir}/Dockerfile`}"`,
                ],
              },
              post_build: {
                commands: [
                  // Push candidate tag -> wait for scan -> block on CRITICAL/HIGH
                  // (minus the allow-list) -> promote to latest -> update Lambda.
                  // See ECR_SCAN_GATE_SCRIPT.
                  'echo "Running ECR vulnerability scan gate (push candidate -> scan -> promote latest)..."',
                  `echo ${Buffer.from(ECR_SCAN_GATE_SCRIPT).toString("base64")} | base64 -d > /tmp/ecr-scan-gate.sh && SCAN_ALLOWED_FINDINGS="${scanAllowListEnv(ECR_SCAN_ALLOWED_FINDINGS)}" bash /tmp/ecr-scan-gate.sh`,
                ],
              },
            },
          }),
        }
      );

      this.buildProjects[lambda.name] = buildProject;


      // Add build action to the list
      buildActions.push(
        new codepipeline_actions.CodeBuildAction({
          actionName: `Build_${lambda.name}`,
          project: buildProject,
          input: sourceOutput,
        })
      );
    });

    // Add build stage with all build actions
    pipeline.addStage({
      stageName: "Build",
      actions: buildActions,
    });
  }
}