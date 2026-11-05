import {
  App,
  GitHubSourceCodeProvider,
  RedirectStatus,
} from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import { BuildSpec } from "aws-cdk-lib/aws-codebuild";
import { Construct } from "constructs";
import * as yaml from "yaml";
import { ApiGatewayStack, GATEWAY_ALLOWED_ORIGIN_VARIABLE, REST_API_STAGE_NAME } from "./api-stack";

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
}

export class AmplifyStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    apiStack: ApiGatewayStack,
    props: AmplifyStackProps
  ) {
    super(scope, id, props);

    const githubRepoName = props.githubRepo;

    const amplifyYaml = yaml.parse(`
      version: 1
      applications:
        - appRoot: frontend
          frontend:
            phases:
              preBuild:
                commands:
                  - pwd
                  - npm ci
              build:
                commands:
                  # Lint and unit tests gate the deploy; a failure stops the build.
                  - npm run lint
                  - npm test
                  - npm run build
            artifacts:
              baseDirectory: dist
              files:
                - '**/*'
            cache:
              paths:
                - 'node_modules/**/*'
            redirects:
              - source: </^[^.]+$|.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>
                target: /
                status: 404
    `);

    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "KC-owner-name"
    );

    const amplifyApp = new App(this, `${id}-amplifyApp`, {
      appName: `${id}-amplify`,
      sourceCodeProvider: new GitHubSourceCodeProvider({
        owner: username,
        repository: githubRepoName,
        oauthToken: cdk.SecretValue.secretsManager(
          "github-personal-access-token",
          {
            jsonField: "my-github-token",
          }
        ),
      }),
      environmentVariables: {
        VITE_AWS_REGION: this.region,
        VITE_COGNITO_USER_POOL_ID: apiStack.getUserPoolId(),
        VITE_COGNITO_USER_POOL_CLIENT_ID: apiStack.getUserPoolClientId(),
        VITE_API_ENDPOINT: apiStack.getEndpointUrl(),
        VITE_IDENTITY_POOL_ID: apiStack.getIdentityPoolId(),
        VITE_WEBSOCKET_URL: `${apiStack.getWebSocketUrl()}/${apiStack.getStageName() ?? ""
          }`,
      },
      buildSpec: BuildSpec.fromObjectToYaml(amplifyYaml),
      // appRoot must match the build spec's monorepo appRoot or Amplify
      // ignores the headers. Header changes take effect on the next deploy
      // of the branch.
      customResponseHeaders: [
        {
          appRoot: "frontend",
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
    const branchOptions = { pullRequestPreview: false };

    // Add main branch
    amplifyApp.addBranch("main", branchOptions);

    // Add feature branch if specified and not main
    const branch = props.githubBranch ?? "main";
    if (branch !== "main") {
      amplifyApp.addBranch(branch, branchOptions);
    }

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
}
