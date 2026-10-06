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

export class CICDStack extends cdk.Stack {
  public readonly ecrRepositories: { [key: string]: ecr.Repository } = {};
  public readonly buildProjects: { [key: string]: codebuild.IProject } = {};
  public readonly pipelineName: string;

  constructor(scope: Construct, id: string, props: CICDStackProps) {
    super(scope, id, props);

    const envName = props.environmentName ?? "dev";
    this.pipelineName = `${id}-DockerImagePipeline`;

    // Create a common role for all CodeBuild projects
    const codeBuildRole = new iam.Role(this, "DockerBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    codeBuildRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryPowerUser"
      )
    );

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
    const githubConnection = new codeconnections.CfnConnection(
      this,
      "GitHubConnectionV2",
      {
        connectionName: `${id}-github-conn`,
        providerType: "GitHub",
      }
    );

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
        imageTagMutability: ecr.TagMutability.MUTABLE,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        imageScanOnPush: true,
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
                  "IMAGE_TAG=${MODULE_NAME}-${ENVIRONMENT}-${COMMIT_HASH}",
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
                  "docker tag $REPOSITORY_URI:$IMAGE_TAG $REPOSITORY_URI:latest",
                  "docker push $REPOSITORY_URI:$IMAGE_TAG",
                  "docker push $REPOSITORY_URI:latest",
                  'echo "Waiting for vulnerability scan to complete..."',
                  "sleep 30",
                  'echo "Checking vulnerability scan results..."',
                  // Combine the vulnerability check into a single command using bash script
                  `bash -c '
                    SCAN_RESULTS=$(aws ecr describe-image-scan-findings \
                      --repository-name $REPO_NAME \
                      --image-id imageTag=latest \
                      --no-paginate \
                      --query "imageScanFindings.findingSeverityCounts.CRITICAL" \
                      --output text 2>/dev/null || echo "0")
                    
                    if [[ "$SCAN_RESULTS" != "0" && "$SCAN_RESULTS" != "None" ]]; then
                      echo "CRITICAL vulnerabilities found: $SCAN_RESULTS. Blocking deployment."
                      exit 1
                    else
                      echo "No critical vulnerabilities found. Proceeding with deployment."
                    fi
                  '`,
                  'echo "Checking if Lambda function exists before updating..."',
                  // Combine the Lambda update into a single command
                  `bash -c '
                    if aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME &>/dev/null; then
                      echo "Updating Lambda function to use the new image..."
                      aws lambda update-function-code \
                        --function-name $LAMBDA_FUNCTION_NAME \
                        --image-uri $REPOSITORY_URI:latest
                    else
                      echo "Lambda function $LAMBDA_FUNCTION_NAME does not exist yet. Skipping update."
                    fi
                  '`,
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