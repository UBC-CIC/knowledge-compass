import { App, RedirectStatus } from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { ApiGatewayStack, GATEWAY_ALLOWED_ORIGIN_VARIABLE, REST_API_STAGE_NAME } from "./api-stack";

/**
 * Deploys a built frontend (the current directory: the CodeBuild input
 * artifact holding the contents of frontend/dist) to an Amplify branch as a
 * manual deployment: create-deployment -> upload zip -> start-deployment ->
 * wait for the job. Fails if the app is still connected to a repository,
 * because Amplify accepts manual deployments only for apps without one.
 * The presigned upload URL is never printed. Embedded base64-encoded in the
 * buildspec, like the ECR scan gate; exported so tests can read it.
 */
export const FRONTEND_DEPLOY_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
: "\${AMPLIFY_APP_ID:?}" "\${AMPLIFY_BRANCH:?}"

MAX_ATTEMPTS="\${DEPLOY_MAX_ATTEMPTS:-90}"
INTERVAL="\${DEPLOY_POLL_INTERVAL:-10}"

REPOSITORY=$(aws amplify get-app --app-id "$AMPLIFY_APP_ID" --query 'app.repository' --output text)
if [ -n "$REPOSITORY" ] && [ "$REPOSITORY" != "None" ]; then
  echo "Amplify app $AMPLIFY_APP_ID is still connected to $REPOSITORY."
  echo "Manual deployments need an app with no repository. See Docs/CICD_PIPELINE.md."
  exit 1
fi

if [ ! -f index.html ]; then
  echo "Build artifact has no index.html. Not deploying."
  exit 1
fi

ZIP_FILE=/tmp/frontend.zip
rm -f "$ZIP_FILE"
zip -qr "$ZIP_FILE" .

read -r JOB_ID UPLOAD_URL <<< "$(aws amplify create-deployment --app-id "$AMPLIFY_APP_ID" \\
  --branch-name "$AMPLIFY_BRANCH" --query '[jobId, zipUploadUrl]' --output text)"
if [ -z "\${JOB_ID:-}" ] || [ -z "\${UPLOAD_URL:-}" ]; then
  echo "create-deployment returned no job. Not deploying."
  exit 1
fi
echo "Created Amplify deployment job $JOB_ID for branch $AMPLIFY_BRANCH"

curl --fail --silent --show-error -X PUT -H "Content-Type: application/zip" \\
  --upload-file "$ZIP_FILE" "$UPLOAD_URL"
aws amplify start-deployment --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" \\
  --job-id "$JOB_ID" >/dev/null

attempt=0
while :; do
  attempt=$((attempt + 1))
  STATUS=$(aws amplify get-job --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" \\
    --job-id "$JOB_ID" --query 'job.summary.status' --output text)
  case "$STATUS" in
    SUCCEED) echo "Amplify job $JOB_ID succeeded."; exit 0 ;;
    CREATED|PENDING|PROVISIONING|RUNNING) ;;
    *) echo "Amplify job $JOB_ID finished with status $STATUS."; exit 1 ;;
  esac
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "Timed out waiting for Amplify job $JOB_ID (last status: $STATUS)."
    exit 1
  fi
  sleep "$INTERVAL"
done
`;

/** Origins the SPA's Content-Security-Policy lets it connect to. */
export interface SpaConnectOrigins {
  /** e.g. https://abc123.execute-api.ca-central-1.amazonaws.com (no path) */
  restApiOrigin: string;
  /** e.g. wss://def456.execute-api.ca-central-1.amazonaws.com (no path) */
  webSocketOrigin: string;
  region: string;
}

/**
 * Security headers for every file Amplify serves (finding F12 / M6).
 *
 * The CSP is enforced (finding f-9ff3f181). It first shipped as
 * Content-Security-Policy-Report-Only (decision D8); if a change ever needs a
 * new source, add it here rather than reverting to Report-Only.
 *
 * - script-src 'self': Vite emits only same-origin module scripts.
 * - style-src 'unsafe-inline': Radix Dialog/Select inject <style> tags
 *   (react-remove-scroll); static hosting cannot issue nonces.
 * - Google Fonts: stylesheet from fonts.googleapis.com (index.html), font
 *   files from fonts.gstatic.com.
 * - connect-src: the REST API and WebSocket API, Cognito user pool sign-in
 *   (the identity pool is not used by the SPA), and S3 presigned uploads,
 *   which are virtual-hosted (helpers/generate_presigned_url*.py).
 * - img-src data:/blob:: inline icons and admin-side object URLs. Markdown
 *   images in chat replies are not loaded at all (F11).
 */
export function spaSecurityHeaders(origins: SpaConnectOrigins): Record<string, string> {
  const { restApiOrigin, webSocketOrigin, region } = origins;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    [
      "connect-src 'self'",
      restApiOrigin,
      webSocketOrigin,
      `https://cognito-idp.${region}.amazonaws.com`,
      `https://*.s3.${region}.amazonaws.com`,
    ].filter(Boolean).join(" "),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy": csp,
  };
}

interface AmplifyStackProps extends cdk.StackProps {
  githubRepo: string;
  githubBranch?: string;
  ingestBucketName: string;
  allowedOriginsParamName: string;
  /** CodeConnections GitHub connection created by the CICD stack. */
  githubConnectionArn: string;
}

export class AmplifyStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    apiStack: ApiGatewayStack,
    props: AmplifyStackProps
  ) {
    super(scope, id, props);

    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "KC-owner-name"
    );

    // No repository connection, so no GitHub token: the frontend pipeline
    // below builds from the CICD stack's CodeConnections connection and
    // pushes the build to Amplify as a manual deployment. The app is static
    // hosting only; build settings and VITE_* variables live in the pipeline.
    const amplifyApp = new App(this, `${id}-amplifyApp`, {
      appName: `${id}-amplify`,
      // No appRoot: without a repository there is no monorepo build spec, so
      // the headers use the single-app customHeaders format. Header changes
      // take effect on the next deployment of the branch.
      customResponseHeaders: [
        {
          pattern: "**",
          headers: spaSecurityHeaders({
            restApiOrigin: `https://${apiStack.getRestApiId()}.execute-api.${this.region}.${this.urlSuffix}`,
            webSocketOrigin: apiStack.getWebSocketUrl(),
            region: this.region,
          }),
        },
      ],
    });

    amplifyApp.addCustomRule({
      source: "/<*>",
      target: "\t/index.html",
      status: RedirectStatus.NOT_FOUND_REWRITE,
    });

    // No pull-request previews (the construct defaults them on): each preview builds
    // unreviewed PR code with the app's build environment and serves it on its own
    // public amplifyapp.com URL.
    // autoBuild off: Amplify never builds from a repository; the pipeline
    // deploys. PR previews off as well (the construct defaults them on).
    const branchOptions = { pullRequestPreview: false, autoBuild: false };

    // Add main branch
    amplifyApp.addBranch("main", branchOptions);

    // Add feature branch if specified and not main. Only this branch
    // (githubBranch, default main) receives pipeline deployments.
    const branch = props.githubBranch ?? "main";
    if (branch !== "main") {
      amplifyApp.addBranch(branch, branchOptions);
    }

    this.addFrontendPipeline(id, apiStack, props, username, amplifyApp, branch);

    // -- UPDATE THE SSM PARAMETER TO POINT TO THE AMPLIFY APP URL --
    const amplifyUrl = `https://${branch}.${amplifyApp.appId}.amplifyapp.com`;

    // Set the allowed origins to the Amplify URL.
    // To add additional origins (e.g. custom domains), update the SSM parameter manually.
    // See Docs/DEPLOYMENT_GUIDE.md for instructions.
    // Lambda responses honor the full list. Gateway error and preflight CORS
    // can carry only this one SPA origin (stage variable allowedOrigin).
    const updateAllowedOrigins = new cdk.custom_resources.AwsCustomResource(this, "UpdateSSMAllowedOrigins", {
      onCreate: {
        service: "SSM",
        action: "putParameter",
        parameters: {
          Name: props.allowedOriginsParamName,
          Value: amplifyUrl,
          Type: "String",
          Overwrite: true,
        },
        physicalResourceId: cdk.custom_resources.PhysicalResourceId.of("UpdateSSMAllowedOrigins"),
      },
      policy: cdk.custom_resources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${props.allowedOriginsParamName}`,
        ],
      }),
    });

    // Pin the gateway stage variable to the same SPA origin written above.
    // onUpdate covers a later branch change; it does not rewrite the SSM list,
    // so manually appended origins stay in place for Lambda responses.
    const pinGatewayOrigin: cdk.custom_resources.AwsSdkCall = {
      service: "APIGateway",
      action: "updateStage",
      parameters: {
        restApiId: apiStack.getRestApiId(),
        stageName: apiStack.getRestApiStageName(),
        patchOperations: [
          {
            op: "replace",
            path: `/variables/${GATEWAY_ALLOWED_ORIGIN_VARIABLE}`,
            value: amplifyUrl,
          },
        ],
      },
      physicalResourceId: cdk.custom_resources.PhysicalResourceId.of("GatewayAllowedOriginStage"),
    };
    const pinGatewayAllowedOrigin = new cdk.custom_resources.AwsCustomResource(this, "PinGatewayAllowedOrigin", {
      onCreate: pinGatewayOrigin,
      onUpdate: pinGatewayOrigin,
      policy: cdk.custom_resources.AwsCustomResourcePolicy.fromStatements([
        new cdk.aws_iam.PolicyStatement({
          actions: ["apigateway:PATCH"],
          resources: [
            `arn:${this.partition}:apigateway:${this.region}::/restapis/${apiStack.getRestApiId()}/stages/${REST_API_STAGE_NAME}`,
          ],
        }),
      ]),
    });
    pinGatewayAllowedOrigin.node.addDependency(updateAllowedOrigins);

    new cdk.custom_resources.AwsCustomResource(this, "UpdateS3BucketCors", {
      onCreate: {
        service: "S3",
        action: "putBucketCors",
        parameters: {
          Bucket: props.ingestBucketName,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedHeaders: ["*"],
                AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
                AllowedOrigins: [amplifyUrl],
                ExposeHeaders: ["ETag"],
              },
            ],
          },
        },
        physicalResourceId: cdk.custom_resources.PhysicalResourceId.of("UpdateS3BucketCors"),
      },
      policy: cdk.custom_resources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [`arn:aws:s3:::${props.ingestBucketName}`],
      }),
    });
  }

  /**
   * Frontend pipeline: GitHub (CodeConnections, only on pushes that touch
   * frontend/) -> lint, test and build -> manual Amplify deployment.
   * Build and deploy are separate projects so the npm dependencies run in a
   * project with no AWS permissions beyond CodeBuild's defaults, and the
   * project that can deploy runs no repository code.
   */
  private addFrontendPipeline(
    id: string,
    apiStack: ApiGatewayStack,
    props: AmplifyStackProps,
    username: string,
    amplifyApp: App,
    branch: string,
  ): void {
    const artifactAccessLogsBucket = new s3.Bucket(this, "FrontendArtifactAccessLogs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true,
    });

    const artifactBucket = new s3.Bucket(this, "FrontendPipelineArtifactBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true,
      serverAccessLogsBucket: artifactAccessLogsBucket,
      serverAccessLogsPrefix: "pipeline-artifacts/",
    });

    const sourceOutput = new codepipeline.Artifact("FrontendSource");
    const distOutput = new codepipeline.Artifact("FrontendDist");

    // CDK grants codestar-connections:UseConnection on the connection ARN.
    // Connections created since July 2024 have codeconnections ARNs, and the
    // IAM prefix must match the ARN prefix, so grant both.
    // Only this pipeline's role may assume the source role, so no other
    // principal in the account can use the GitHub connection through it.
    const pipelineRole = new iam.Role(this, "FrontendPipelineServiceRole", {
      assumedBy: new iam.ServicePrincipal("codepipeline.amazonaws.com"),
    });
    const sourceRole = new iam.Role(this, "FrontendSourceActionRole", {
      assumedBy: new iam.ArnPrincipal(pipelineRole.roleArn),
    });
    sourceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["codeconnections:UseConnection", "codestar-connections:UseConnection"],
        resources: [props.githubConnectionArn],
      })
    );

    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: "GitHub",
      owner: username,
      repo: props.githubRepo,
      branch,
      connectionArn: props.githubConnectionArn,
      output: sourceOutput,
      role: sourceRole,
      // The pipeline trigger below starts runs, filtered to frontend/ changes.
      triggerOnPush: false,
    });

    const buildProject = new codebuild.PipelineProject(this, "FrontendBuildProject", {
      projectName: `${id}-FrontendBuild`,
      description: "Lint, test and build the frontend (no AWS permissions)",
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      timeout: cdk.Duration.minutes(20),
      // Public client configuration baked into the bundle at build time.
      environmentVariables: {
        VITE_AWS_REGION: { value: this.region },
        VITE_COGNITO_USER_POOL_ID: { value: apiStack.getUserPoolId() },
        VITE_COGNITO_USER_POOL_CLIENT_ID: { value: apiStack.getUserPoolClientId() },
        VITE_API_ENDPOINT: { value: apiStack.getEndpointUrl() },
        VITE_IDENTITY_POOL_ID: { value: apiStack.getIdentityPoolId() },
        VITE_WEBSOCKET_URL: {
          value: `${apiStack.getWebSocketUrl()}/${apiStack.getStageName() ?? ""}`,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            // vitest 5 and ESLint 10 need Node >= 22.13, and Node 20 is
            // end-of-life. Node 24 is LTS until 2028-04-30.
            "runtime-versions": { nodejs: "24" },
          },
          build: {
            commands: [
              "cd $CODEBUILD_SRC_DIR/frontend && node -v && npm ci",
              // Lint and unit tests gate the deploy; a failure stops the pipeline.
              "cd $CODEBUILD_SRC_DIR/frontend && npm run lint",
              "cd $CODEBUILD_SRC_DIR/frontend && npm test",
              "cd $CODEBUILD_SRC_DIR/frontend && npm run build",
            ],
          },
        },
        artifacts: {
          "base-directory": "frontend/dist",
          files: ["**/*"],
        },
      }),
    });

    const deployProject = new codebuild.PipelineProject(this, "FrontendDeployProject", {
      projectName: `${id}-FrontendDeploy`,
      description: "Deploy the built frontend to Amplify Hosting",
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      timeout: cdk.Duration.minutes(20),
      environmentVariables: {
        AMPLIFY_APP_ID: { value: amplifyApp.appId },
        AMPLIFY_BRANCH: { value: branch },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          build: {
            commands: [
              `echo ${Buffer.from(FRONTEND_DEPLOY_SCRIPT).toString("base64")} | base64 -d > /tmp/amplify-deploy.sh && bash /tmp/amplify-deploy.sh`,
            ],
          },
        },
      }),
    });

    // Deploy access is limited to this app's deployment branch.
    const branchArn = `${amplifyApp.arn}/branches/${branch}`;
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["amplify:GetApp"],
        resources: [amplifyApp.arn],
      })
    );
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["amplify:CreateDeployment", "amplify:StartDeployment", "amplify:GetJob"],
        resources: [branchArn, `${branchArn}/jobs/*`],
      })
    );

    new codepipeline.Pipeline(this, "FrontendPipeline", {
      pipelineName: `${id}-FrontendPipeline`,
      pipelineType: codepipeline.PipelineType.V2,
      role: pipelineRole,
      artifactBucket,
      triggers: [
        {
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: {
            sourceAction,
            pushFilter: [
              {
                branchesIncludes: [branch],
                filePathsIncludes: ["frontend/**"],
              },
            ],
          },
        },
      ],
      stages: [
        { stageName: "Source", actions: [sourceAction] },
        {
          stageName: "Build",
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: "LintTestBuild",
              project: buildProject,
              input: sourceOutput,
              outputs: [distOutput],
            }),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: "AmplifyDeploy",
              project: deployProject,
              input: distOutput,
            }),
          ],
        },
      ],
    });
  }
}
