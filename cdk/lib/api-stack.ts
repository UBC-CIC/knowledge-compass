import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Code, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Fn } from "aws-cdk-lib";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as kms from "aws-cdk-lib/aws-kms";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cr from "aws-cdk-lib/custom-resources";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as crypto from 'crypto';
import * as path from "path";

// REST stage name. The WAF association and execute-api ARNs also use "prod".
export const REST_API_STAGE_NAME = "prod";
// OpenAPI gateway responses and OPTIONS mocks read this stage variable.
// gatewayCorsOrigin copies the deployed SPA origin into it; never "*".
export const GATEWAY_ALLOWED_ORIGIN_VARIABLE = "allowedOrigin";

function computeConfigHash(config: object): string {
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

// Custom regex PII filters for the input guardrail. They replace Bedrock's
// ADDRESS entity, which also masks city/province/country and stripped the
// location families need for jurisdiction-specific answers. Street addresses
// and postal codes are still masked. Bedrock regexes do not support lookaround.
export const GUARDRAIL_REGEXES_CONFIG: bedrock.CfnGuardrail.RegexConfigProperty[] = [
  {
    name: 'CA_POSTAL_CODE',
    description: 'Canadian postal code, e.g. K1A 0B1',
    pattern: String.raw`\b[ABCEGHJ-NPRSTVXYabceghj-nprstvxy]\d[ABCEGHJ-NPRSTV-Zabceghj-nprstv-z][ -]?\d[ABCEGHJ-NPRSTV-Zabceghj-nprstv-z]\d\b`,
    action: 'ANONYMIZE',
    inputAction: 'ANONYMIZE',
    inputEnabled: true,
  },
  {
    name: 'STREET_ADDRESS',
    description: 'House number, street name and street type, e.g. 123 Main Street',
    pattern: String.raw`\b\d{1,6}[A-Za-z]?(?:-\d{1,6})?\s+(?:[A-Z0-9][^\s,]*\s+){1,3}(?:[Ss]treet|[Ss]t|[Aa]venue|[Aa]ve|[Rr]oad|[Rr]d|[Bb]oulevard|[Bb]lvd|[Dd]rive|[Dd]r|[Cc]rescent|[Cc]res|[Cc]t|[Ww]ay|[Ll]ane|[Ll]n|[Pp]lace|[Pp]l|[Tt]errace|[Cc]ircle|[Cc]ir|[Hh]ighway|[Hh]wy|[Pp]arkway|[Pp]kwy|[Tt]rail|[Tt]rl)\b\.?`,
    action: 'ANONYMIZE',
    inputAction: 'ANONYMIZE',
    inputEnabled: true,
  },
];

/**
 * Per-IP WAF rate rules (finding f-9bda4252).
 *
 * WAF runs before the API Gateway authorizer and never sees its result, so a
 * bucket must not be chosen from the Authorization header. `Authorization:
 * Bearer x` is attacker-controlled and was enough to leave the 100-request
 * bucket for the 2000-request one. A limit is scoped to the URI path, or it
 * is a ceiling on every request.
 */
export function wafIpRateLimitRules(): wafv2.CfnWebACL.RuleProperty[] {
  return [
    // GET /user/publicToken is the only data route with no authorizer. The
    // match is the URI path, including a stage prefix (`/prod/user/publicToken`).
    // URL_DECODE so `/user%2FpublicToken` cannot skip it. LimitIdentityMinting
    // below is the tighter cap (60/5 min) and also covers a trailing slash and
    // POST /user.
    {
      name: "LimitUnauthenticatedRequests",
      priority: 3,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: 100,
          aggregateKeyType: "IP",
          evaluationWindowSec: 300,
          scopeDownStatement: {
            byteMatchStatement: {
              searchString: "/user/publicToken",
              fieldToMatch: { uriPath: {} },
              textTransformations: [{ priority: 0, type: "URL_DECODE" }],
              positionalConstraint: "ENDS_WITH",
            },
          },
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "LimitUnauthenticatedRequests",
      },
    },

    // Global per-IP ceiling. No scope-down: sending a header cannot raise the
    // limit. A rate rule under its limit does not terminate evaluation, so the
    // tighter path rules (token minting, /chat_sessions) still block.
    // The name is unchanged so the existing CloudWatch metric stays continuous.
    {
      name: "LimitAuthenticatedRequests",
      priority: 4,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: 2000,
          aggregateKeyType: "IP",
          evaluationWindowSec: 300,
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "LimitAuthenticatedRequests",
      },
    },

    // Moderate limit for expensive AI endpoints (1000 req/5min per IP).
    {
      name: "LimitExpensiveEndpoints",
      priority: 5,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: 1000, // prevents abuse while allowing rapid conversational flow
          aggregateKeyType: "IP",
          scopeDownStatement: {
            byteMatchStatement: {
              searchString: "/chat_sessions",
              fieldToMatch: { uriPath: {} },
              textTransformations: [{ priority: 0, type: "NONE" }],
              positionalConstraint: "CONTAINS",
            },
          },
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "LimitExpensiveEndpoints",
      },
    },

    // Strict limit on anonymous identity minting (60 req/5min per IP).
    // POST /user creates a new anonymous user and /user/publicToken mints
    // credentials for it. Neither requires prior identity, so without a
    // dedicated cap a single client can mint unlimited identities and
    // sidestep every per-user limit. A legitimate first visit needs ~3 of
    // these calls and each 15-minute refresh needs 1.
    // Paths are URL-decoded and matched with an optional trailing slash so
    // variants such as `/prod/user/` or `/prod/user%2FpublicToken` that API
    // Gateway may still route to the same resource cannot skip this cap.
    {
      name: "LimitIdentityMinting",
      priority: 6,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: 60,
          evaluationWindowSec: 300,
          aggregateKeyType: "IP",
          scopeDownStatement: {
            orStatement: {
              statements: [
                {
                  regexMatchStatement: {
                    regexString: "/user/publicToken/?$",
                    fieldToMatch: { uriPath: {} },
                    textTransformations: [{ priority: 0, type: "URL_DECODE" }],
                  },
                },
                {
                  andStatement: {
                    statements: [
                      {
                        regexMatchStatement: {
                          regexString: "/user/?$",
                          fieldToMatch: { uriPath: {} },
                          textTransformations: [{ priority: 0, type: "URL_DECODE" }],
                        },
                      },
                      {
                        byteMatchStatement: {
                          searchString: "POST",
                          fieldToMatch: { method: {} },
                          textTransformations: [{ priority: 0, type: "NONE" }],
                          positionalConstraint: "EXACTLY",
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "LimitIdentityMinting",
      },
    },
  ];
}

interface ApiGatewayStackProps extends cdk.StackProps {
  ecrRepositories: { [key: string]: ecr.Repository };
  // pgvector ingestion wiring (R2/R12). Structural to avoid a hard
  // import/coupling to IngestionStack. Sets INGESTION_BACKEND=pgvector + ECS
  // run permissions and grants the admin Lambda access to the ingest bucket.
  ingestion?: {
    ingestionEnv: () => { [key: string]: string };
    grantRunTasks: (principal: iam.IGrantable & { addToRolePolicy?: (s: iam.PolicyStatement) => void }) => void;
    grantBucketAccess: (principal: iam.IGrantable) => void;
  };
  // Name of the evaluation-harness signing secret (EvalStack, evals/). A plain
  // string, not a token: the grant below uses a hand-built ARN so this stack
  // never depends on EvalStack. If the secret does not exist, eval tags fail
  // closed and every session is a normal one.
  evalSigningSecretName?: string;
  // Optional email subscribed to the operational alarm topic (context `alarmEmail`).
  // Without it the topic and every alarm action still exist, with no subscriber.
  alarmEmail?: string;
  // Reserve concurrency for the public Lambdas (context `enableReservedConcurrency`).
  // Off by default: needs an account concurrency quota of at least 350 (100 must
  // stay unreserved), otherwise the deploy fails.
  enableReservedConcurrency?: boolean;
}

export class ApiGatewayStack extends cdk.Stack {
  private readonly api: apigateway.SpecRestApi;
  public readonly appClient: cognito.UserPoolClient;
  public readonly userPool: cognito.UserPool;
  public readonly identityPool: cognito.CfnIdentityPool;
  private readonly layerList: { [key: string]: lambda.ILayerVersion };
  public readonly stageARN_APIGW: string;
  public readonly apiGW_basedURL: string;
  public readonly secret: secretsmanager.ISecret;
  public readonly allowedOriginsParamName: string;
  // Operational alarm topic; the CostStack sends budget and anomaly alerts here too.
  public readonly opsAlarmTopic: sns.ITopic;
  public getEndpointUrl = () => this.api.url;
  public getRestApiId = () => this.api.restApiId;
  public getRestApiStageName = () => REST_API_STAGE_NAME;
  public getUserPoolId = () => this.userPool.userPoolId;
  public getUserPoolClientId = () => this.appClient.userPoolClientId;
  public getIdentityPoolId = () => this.identityPool.ref;
  public addLayer = (name: string, layer: lambda.ILayerVersion) =>
    (this.layerList[name] = layer);
  public getLayers = () => this.layerList;
  private readonly webSocketApi?: apigatewayv2.WebSocketApi;
  private readonly wsStage?: apigatewayv2.CfnStage;
  public getWebSocketUrl = () => this.webSocketApi?.apiEndpoint ?? "";
  public getStageName = () => this.wsStage?.stageName ?? "";

  constructor(
    scope: Construct,
    id: string,
    db: DatabaseStack,
    vpcStack: VpcStack,
    props: ApiGatewayStackProps
  ) {
    super(scope, id, props);

    // Reserved concurrency for a public Lambda, or undefined (unreserved) when the
    // opt-in flag is off.
    const reservedConcurrency = (executions: number) =>
      props.enableReservedConcurrency ? executions : undefined;

    this.layerList = {};
    /**
     *
     * Create Integration Lambda layer for aws-jwt-verify
     */
    const jwt = new lambda.LayerVersion(this, "aws-jwt-verify", {
      code: lambda.Code.fromAsset("./layers/aws-jwt-verify.zip"),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      description: "Contains the aws-jwt-verify library for JS",
    });

    /**
     *
     * Create Integration Lambda layer for PSQL
     */
    const postgres = new lambda.LayerVersion(this, "postgres", {
      code: lambda.Code.fromAsset("./layers/postgres.zip"),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      description: "Contains the postgres library for JS",
    });

    /**
     *
     * Create Lambda layer for Psycopg2
     */
    const psycopgLayer = new lambda.LayerVersion(this, "psycopgLambdaLayer", {
      code: lambda.Code.fromAsset("./layers/psycopg2.zip"),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: "Lambda layer containing the psycopg2 Python library",
    });

    // Create Allowed Origin Parameters
      this.allowedOriginsParamName = `/${id}/API/AllowedOrigins`;
      const crParams = {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: this.allowedOriginsParamName,
            Value: 'http://localhost:5173/',
            Type: 'String',
            Description: 'List of allowed CORS origins for the API',
          },
          physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString()),
          ignoreErrorCodesMatching: 'ParameterAlreadyExists',
        };
    
        const initAllowedOrigins = new cr.AwsCustomResource(this, 'InitAllowedOriginsParamV2', {
          onCreate: crParams,
          onUpdate: crParams,
          policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
          }),
        });

    // powertoolsLayer does not follow the format of layerList
    const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      `${id}-PowertoolsLayer`,
      `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV2:78`
    );

    this.layerList["jwt"] = jwt;
    this.layerList["postgres"] = postgres;
    this.layerList["psycopg2"] = psycopgLayer;
    this.layerList["powertools"] = powertoolsLayer;

    const userPoolName = `${id}-UserPool`;
    this.userPool = new cognito.UserPool(this, `${id}-pool`, {
      userPoolName: userPoolName,
      signInAliases: {
        email: true,
      },
      // Admins only: accounts are created by an existing admin (console or
      // admin-create-user, see Docs/DEPLOYMENT_GUIDE.md), never self-registered.
      selfSignUpEnabled: false,
      // TOTP authenticator apps are REQUIRED for every admin (finding
      // f-7f03f151). The admin login page (pages/Admin/AdminLogin.tsx) runs the
      // TOTP setup step at an admin's first sign-in after this change.
      // MfaConfiguration is "Update requires: No interruption", and deletion
      // protection + RETAIN guard against replacement. If Cognito rejects the
      // change on the existing pool, revert to cognito.Mfa.OPTIONAL.
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: {
        otp: true,
        sms: false,
      },
      deletionProtection: true,
      autoVerify: {
        email: true,
      },
      userVerification: {
        emailSubject: "Knowledge Compass - Verify your email",
        emailBody: `
                    <html>
                        <head>
                            <style>
                            body {
                                font-family: Outfit, sans-serif;
                                background-color: #F5F5F5;
                                color: #111835;
                                margin: 0;
                                padding: 0;
                                font-size: 16px;
                            }
                            .email-container {
                                background-color: #ffffff;
                                width: 100%;
                                max-width: 600px;
                                margin: 0 auto;
                                padding: 20px;
                                border-radius: 8px;
                                border: 1px solid #ddd;
                            }
                            .header {
                                text-align: center;
                                margin-bottom: 20px;
                            }
                            .header img {
                                width: 100px;
                                height: auto;
                            }
                            .main-content {
                                text-align: center;
                                font-size: 18px;
                                color: #444;
                                margin-bottom: 30px;
                            }
                            .code {
                                display: inline-block;
                                background-color: #111835;
                                color: #ffffff;
                                font-size: 24px;
                                font-weight: bold;
                                padding: 15px 25px;
                                border-radius: 4px;
                                margin-top: 20px;
                                margin-bottom: 20px;
                            }
                            .footer {
                                text-align: center;
                                font-size: 14px;
                                color: #888;
                            }
                            .footer a {
                                color: #546bdf;
                                text-decoration: none;
                            }
                            </style>
                            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&display=swap" rel="stylesheet">
                        </head>
                        <body>
                            <div class="email-container">
                            <div class="header">
                                <h1>Knowledge Compass</h1>
                            </div>
                            <div class="main-content">
                                <p>Thank you for signing up for Knowledge Compass.</p>
                                <p>Verify your email by using the code below:</p>
                                <div class="code">{####}</div>
                                <p>If you did not request this verification, please ignore this email.</p>
                            </div>
                            <div class="footer">
                                <p>Please do not reply to this email.</p>
                                <p>Knowledge Compass, Inclusion Canada</p>
                            </div>
                            </div>
                        </body>
                    </html>
          `,
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      passwordPolicy: {
        minLength: 10,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Keep the pool (and every admin account) if the stack is deleted.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Create app client
    this.appClient = this.userPool.addClient(`${id}-pool`, {
      userPoolClientName: userPoolName,
      // Amplify v6 signIn uses SRP by default (frontend/src/functions/authService.js)
      // and the pool has no custom-auth triggers, so password and custom flows are off.
      authFlows: {
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });

    this.identityPool = new cognito.CfnIdentityPool(
      this,
      `${id}-identity-pool`,
      {
        // No guest credentials: the frontend configures no identityPoolId and public
        // users authenticate with the public-token JWT (finding f-81bbc719).
        allowUnauthenticatedIdentities: false,
        identityPoolName: `${id}IdentityPool`,
        cognitoIdentityProviders: [
          {
            clientId: this.appClient.userPoolClientId,
            providerName: this.userPool.userPoolProviderName,
          },
        ],
      }
    );

    const secretsName = `${id}-KC_Cognito_Secrets`;
    this.secret = new secretsmanager.Secret(this, secretsName, {
      secretName: secretsName,
      description: "Cognito Secrets for authentication",
      secretObjectValue: {
        VITE_COGNITO_USER_POOL_ID: cdk.SecretValue.unsafePlainText(
          this.userPool.userPoolId
        ),
        VITE_COGNITO_USER_POOL_CLIENT_ID: cdk.SecretValue.unsafePlainText(
          this.appClient.userPoolClientId
        ),
        VITE_AWS_REGION: cdk.SecretValue.unsafePlainText(this.region),
        VITE_IDENTITY_POOL_ID: cdk.SecretValue.unsafePlainText(
          this.identityPool.ref
        ),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // create CloudWatch logs role required for WebSocket access logs
    const apiGatewayLogsRole = new iam.Role(this, "ApiGatewayCloudWatchLogsRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonAPIGatewayPushToCloudWatchLogs"
        ),
      ],
    });

    const apiGatewayAccount = new apigateway.CfnAccount(this, "ApiGatewayAccount", {
      cloudWatchRoleArn: apiGatewayLogsRole.roleArn,
    });

    // Create roles and policies
    const createPolicyStatement = (actions: string[], resources: string[]) => {
      return new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: actions,
        resources: resources,
      });
    };

    const asset = new Asset(this, "SampleAsset", {
      path: "OpenAPI_Swagger_Definition.yaml",
    });

    const data = Fn.transform("AWS::Include", { Location: asset.s3ObjectUrl });

    // CMK for the API access-log and WAF log groups. The key policy names log groups
    // by a pseudo-parameter ARN pattern only: referencing a LogGroup token here would
    // create LogGroup -> KmsKeyId -> Key -> policy -> LogGroup (a cycle).
    const apiLogsKey = new kms.Key(this, `${id}-ApiLogsKey`, {
      description: `${id} API Gateway and WAF log encryption`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    apiLogsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "AllowCloudWatchLogsForThisAccountRegion",
      principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      actions: ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"],
      resources: ["*"],
      conditions: {
        ArnLike: {
          "kms:EncryptionContext:aws:logs:arn": `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
        },
      },
    }));
    // Investigation-appropriate default; lower deliberately if needed.
    const apiLogRetention = logs.RetentionDays.ONE_YEAR;
    // Defence in depth: CloudWatch masks email addresses that slip into these logs.
    const apiLogDataProtection = new logs.DataProtectionPolicy({
      name: `${id}-api-logs-data-protection`,
      description: "Mask email addresses in API and WAF logs",
      identifiers: [logs.DataIdentifier.EMAILADDRESS],
    });

    const accessLogGroup = new logs.LogGroup(this, `${id}-ApiAccessLogs`, {
      retention: apiLogRetention,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryptionKey: apiLogsKey,
      dataProtectionPolicy: apiLogDataProtection,
    });

    // Create the API Gateway REST API.
    // SpecRestApi body Refs Lambda logical IDs via OpenAPI Fn::Sub. Do not also
    // Ref this.api (permissions, IAM, env, addGatewayResponse) from those
    // Lambdas — CloudFormation treats that as a cycle and changeset creation fails.
    this.api = new apigateway.SpecRestApi(this, `${id}-APIGateway`, {
      apiDefinition: apigateway.AssetApiDefinition.fromInline(data),
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      restApiName: `${id}-API`,
      deploy: true,
      cloudWatchRole: true,
      deployOptions: {
        stageName: REST_API_STAGE_NAME,
        tracingEnabled: true,
        description: "Deployment with flashcard support - Nov 18 2025",
        // Data trace would record full request and response bodies, including the
        // token minted by GET /user/publicToken and chat bodies, so it stays off.
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        metricsEnabled: true,
        
        accessLogDestination: new apigateway.LogGroupLogDestination(
          accessLogGroup
        ),
        
        // The standard fields (same key names as jsonWithStandardFields, so existing
        // queries keep working) plus the custom authorizers' identity. caller/user are
        // empty under a TOKEN authorizer; the authorizer fields are what attribute a
        // request (finding f-0d57a9d0): admin requests carry the Cognito sub and email
        // (email is masked by apiLogDataProtection unless unmasked by an investigator),
        // user-tier requests carry the bound guest id or "anonymous:<jti>" plus the
        // access token's jti (tokenId). Never the token itself.
        accessLogFormat: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: apigateway.AccessLogField.contextRequestId(),
            ip: apigateway.AccessLogField.contextIdentitySourceIp(),
            caller: apigateway.AccessLogField.contextIdentityCaller(),
            user: apigateway.AccessLogField.contextIdentityUser(),
            requestTime: apigateway.AccessLogField.contextRequestTime(),
            httpMethod: apigateway.AccessLogField.contextHttpMethod(),
            resourcePath: apigateway.AccessLogField.contextResourcePath(),
            status: apigateway.AccessLogField.contextStatus(),
            protocol: apigateway.AccessLogField.contextProtocol(),
            responseLength: apigateway.AccessLogField.contextResponseLength(),
            authorizerPrincipalId: apigateway.AccessLogField.contextAuthorizerPrincipalId(),
            authorizerUserId: apigateway.AccessLogField.contextAuthorizer("userId"),
            authorizerRole: apigateway.AccessLogField.contextAuthorizer("role"),
            authorizerEmail: apigateway.AccessLogField.contextAuthorizer("email"),
            authorizerTokenId: apigateway.AccessLogField.contextAuthorizer("tokenId"),
          })
        ),
        
        methodOptions: {
          // Default for all endpoints
          "/*/*": {
            throttlingRateLimit: 100,
            throttlingBurstLimit: 200,
          },

          // FREQUENT: Public token endpoint
          "/user/publicToken/GET": {
            throttlingRateLimit: 50,
            throttlingBurstLimit: 100,
          },
        },
      },
    });

    this.stageARN_APIGW = this.api.deploymentStage.stageArn;
    this.apiGW_basedURL = this.api.urlForPath();

    // Gateway error responses and OPTIONS mocks cannot run the Lambda origin
    // allow-list. They read the stage variable named in the OpenAPI spec.
    // Seed it from AllowedOrigins (first entry, never "*") so the variable
    // exists; the Amplify stack then pins it to the deployed SPA origin.
    // The stage's Variables property is left unset so a later API deploy does
    // not clear that pin.
    const gatewayCorsOriginFn = new lambda.Function(this, `${id}-GatewayCorsOrigin`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/gatewayCorsOrigin"), {
        exclude: ["tests", "tests/**"],
      }),
      timeout: Duration.seconds(30),
      description: "Publishes the SPA origin onto the API Gateway CORS stage variable",
      environment: {
        ALLOWED_ORIGINS_PARAM: this.allowedOriginsParamName,
        REST_API_ID: this.api.restApiId,
        REST_API_STAGE: REST_API_STAGE_NAME,
        ALLOWED_ORIGIN_VARIABLE: GATEWAY_ALLOWED_ORIGIN_VARIABLE,
      },
    });
    gatewayCorsOriginFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));
    gatewayCorsOriginFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["apigateway:GET", "apigateway:PATCH"],
      resources: [
        `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/stages/${REST_API_STAGE_NAME}`,
      ],
    }));
    const gatewayCorsOrigin = new cdk.CustomResource(this, `${id}-GatewayCorsOriginSync`, {
      serviceToken: new cr.Provider(this, `${id}-GatewayCorsOriginProvider`, {
        onEventHandler: gatewayCorsOriginFn,
      }).serviceToken,
      properties: {
        paramName: this.allowedOriginsParamName,
        restApiId: this.api.restApiId,
        // Re-read AllowedOrigins when the API deployment changes (a replaced
        // stage would otherwise drop the variable). Stable when the API is unchanged.
        deploymentId: this.api.latestDeployment?.deploymentId ?? "none",
      },
    });
    gatewayCorsOrigin.node.addDependency(initAllowedOrigins);
    gatewayCorsOrigin.node.addDependency(this.api.deploymentStage);

    // WAF. Tighter limits are scoped by URI path. No rule selects a bucket from
    // the Authorization header (finding f-9bda4252): WAF runs before the authorizer.
    const waf = new wafv2.CfnWebACL(this, `${id}-waf`, {
      description: "WAF for KC",
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "KC-firewall",
      },
      rules: [
        // Rule 1: AWS Managed Common Rule Set (SQL injection, XSS, etc.) for the
        // two batch admin endpoints ONLY, with SizeRestrictions_BODY exempted
        // (they send large JSON payloads). A managed-rule-group's
        // scopeDownStatement gates evaluation of the WHOLE group, not an
        // individual ruleActionOverride, so the size exemption can only be
        // scoped to these two paths by giving them their own rule instance
        // (Rule 1) separate from the unscoped, full-enforcement instance that
        // covers every other path (Rule 1b). Do not merge these back into one
        // rule with a single scopeDownStatement — that previously exempted
        // these two paths from the ENTIRE managed rule group (SQLi/XSS/etc.
        // included), not just the body-size check.
        {
          name: "AWS-AWSManagedRulesCommonRuleSet-AdminBatchEndpoints",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              ruleActionOverrides: [
                {
                  name: "SizeRestrictions_BODY",
                  actionToUse: { count: {} },
                },
              ],
              scopeDownStatement: {
                orStatement: {
                  statements: [
                    {
                      byteMatchStatement: {
                        searchString: "/admin/generate-presigned-urls/batch",
                        fieldToMatch: { uriPath: {} },
                        textTransformations: [{ priority: 0, type: "NONE" }],
                        positionalConstraint: "ENDS_WITH",
                      },
                    },
                    {
                      byteMatchStatement: {
                        searchString: "/admin/data_sources/batch",
                        fieldToMatch: { uriPath: {} },
                        textTransformations: [{ priority: 0, type: "NONE" }],
                        positionalConstraint: "ENDS_WITH",
                      },
                    },
                  ],
                },
              },
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet-AdminBatchEndpoints",
          },
        },

        // Rule 1b: Same managed rule set, full enforcement (no overrides), for
        // every path OTHER than the two batch admin endpoints above.
        {
          name: "AWS-AWSManagedRulesCommonRuleSet-Default",
          priority: 2,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              scopeDownStatement: {
                notStatement: {
                  statement: {
                    orStatement: {
                      statements: [
                        {
                          byteMatchStatement: {
                            searchString: "/admin/generate-presigned-urls/batch",
                            fieldToMatch: { uriPath: {} },
                            textTransformations: [{ priority: 0, type: "NONE" }],
                            positionalConstraint: "ENDS_WITH",
                          },
                        },
                        {
                          byteMatchStatement: {
                            searchString: "/admin/data_sources/batch",
                            fieldToMatch: { uriPath: {} },
                            textTransformations: [{ priority: 0, type: "NONE" }],
                            positionalConstraint: "ENDS_WITH",
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet-Default",
          },
        },

        ...wafIpRateLimitRules(),

        // Rule 6: AWS Managed IP reputation list (known botnets, scanners and
        // other malicious sources).
        {
          name: "AWS-AWSManagedRulesAmazonIpReputationList",
          priority: 7,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesAmazonIpReputationList",
          },
        },

        // Rule 7: AWS Managed known bad inputs (Log4j/JNDI, invalid paths, etc.).
        {
          name: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
          priority: 8,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(
      this,
      `${id}-waf-association`,
      {
        resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/stages/prod`,
        webAclArn: waf.attrArn,
      }
    );

    // WAF logging. The name must start with "aws-waf-logs-". Only BLOCK
    // decisions are kept so normal traffic is not stored, and the
    // Authorization header is redacted so tokens never reach the logs.
    const wafLogGroup = new logs.LogGroup(this, `${id}-WafLogs`, {
      logGroupName: `aws-waf-logs-${id}`,
      retention: apiLogRetention,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryptionKey: apiLogsKey,
      dataProtectionPolicy: apiLogDataProtection,
    });

    new wafv2.CfnLoggingConfiguration(this, `${id}-waf-logging`, {
      resourceArn: waf.attrArn,
      // WAF rejects the ":*" suffix that LogGroup.logGroupArn carries.
      logDestinationConfigs: [
        cdk.Stack.of(this).formatArn({
          service: "logs",
          resource: "log-group",
          resourceName: wafLogGroup.logGroupName,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      redactedFields: [{ singleHeader: { Name: "authorization" } }],
      loggingFilter: {
        DefaultBehavior: "DROP",
        Filters: [
          {
            Behavior: "KEEP",
            Requirement: "MEETS_ANY",
            Conditions: [{ ActionCondition: { Action: "BLOCK" } }],
          },
        ],
      },
    });

    const adminRole = new iam.Role(this, `${id}-AdminRole`, {
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": this.identityPool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
          // Only identities that signed in through this user pool (finding f-81bbc719).
          "ForAnyValue:StringEquals": {
            "cognito-identity.amazonaws.com:amr":
              this.userPool.userPoolProviderName,
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    adminRole.attachInlinePolicy(
      new iam.Policy(this, `${id}-AdminPolicy`, {
        statements: [
          createPolicyStatement(
            ["execute-api:Invoke"],
            [
              // Scoped to this REST API (finding f-81bbc719). Safe from the documented
              // cycle: this standalone AWS::IAM::Policy only adds Policy -> RestApi and
              // nothing (Lambdas, RestApi, Stage, Role) depends on it. Lambdas must
              // still never Ref this.api, since the SpecRestApi body Refs them.
              `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/prod/*/admin/*`,
              `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/prod/*/user/*`,
            ]
          ),
        ],
      })
    );

    const unauthenticatedRole = new iam.Role(
      this,
      `${id}-UnauthenticatedRole`,
      {
        assumedBy: new iam.FederatedPrincipal(
          "cognito-identity.amazonaws.com",
          {
            StringEquals: {
              "cognito-identity.amazonaws.com:aud": this.identityPool.ref,
            },
            "ForAnyValue:StringLike": {
              "cognito-identity.amazonaws.com:amr": "unauthenticated",
            },
          },
          "sts:AssumeRoleWithWebIdentity"
        ),
      }
    );

    // Default role for non-admin authenticated identities. Intentionally holds no
    // permissions; admins receive adminRole only via the admin group's role claim.
    const authenticatedRole = new iam.Role(
      this,
      `${id}-AuthenticatedRole`,
      {
        assumedBy: new iam.FederatedPrincipal(
          "cognito-identity.amazonaws.com",
          {
            StringEquals: {
              "cognito-identity.amazonaws.com:aud": this.identityPool.ref,
            },
            "ForAnyValue:StringLike": {
              "cognito-identity.amazonaws.com:amr": "authenticated",
            },
          },
          "sts:AssumeRoleWithWebIdentity"
        ),
      }
    );

    const adminGroup = new cognito.CfnUserPoolGroup(this, `${id}-AdminGroup`, {
      groupName: "admin",
      userPoolId: this.userPool.userPoolId,
      roleArn: adminRole.roleArn,
    });

    // Least-privilege execution roles (security finding f-4597100e). Request-handling
    // functions get only what their handler uses, and all carry this boundary: no IAM
    // (except PassRole to the two ingestion services) and no Cognito admin APIs, whatever
    // is granted to them later. Self-contained (no token references), so no new cycle.
    const requestHandlerBoundary = new iam.ManagedPolicy(this, `${id}-RequestHandlerBoundary`, {
      managedPolicyName: `${id}-RequestHandlerBoundary`,
      description: "Permissions boundary for request-handling Lambda roles",
      statements: [
        new iam.PolicyStatement({
          sid: "AllowAllExceptIamAndCognitoAdmin",
          effect: iam.Effect.ALLOW,
          notActions: ["iam:*", "cognito-idp:Admin*"],
          resources: ["*"],
        }),
        // The knowledge-base role passes the ECS task/execution roles and the Transcribe
        // data-access role (IngestionStack.grantRunTasks); its identity policy still pins
        // the role ARNs.
        new iam.PolicyStatement({
          sid: "AllowPassRoleToIngestionServices",
          effect: iam.Effect.ALLOW,
          actions: ["iam:PassRole"],
          resources: ["*"],
          conditions: {
            StringEquals: {
              "iam:PassedToService": ["ecs-tasks.amazonaws.com", "transcribe.amazonaws.com"],
            },
          },
        }),
        new iam.PolicyStatement({
          sid: "DenyCognitoAdmin",
          effect: iam.Effect.DENY,
          actions: ["cognito-idp:Admin*"],
          resources: ["*"],
        }),
      ],
    });

    // Shared by systemMessagesFunction, chatSessionFunction and adminFunction only.
    const lambdaRole = new iam.Role(this, `${id}-postgresLambdaRole`, {
      roleName: `${id}-postgresLambdaRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      permissionsBoundary: requestHandlerBoundary,
    });


    // Grant access to specific secrets instead of '*'
    db.secretPathUser.grantRead(lambdaRole);

    // Grant access to EC2
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        resources: ["*"], // must be *
      })
    );

    // Grant access to log
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Logs
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      })
    );

    // Grant X-Ray tracing permissions
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        resources: ["*"],
      })
    );

    // Dedicated roles for the functions split off lambdaRole. VPC functions get
    // AWSLambdaVPCAccessExecutionRole (ENIs + logs), the out-of-VPC user authorizer
    // AWSLambdaBasicExecutionRole (logs). Traced functions get the same X-Ray statement
    // as lambdaRole. Remaining grants are added per function below (addToRolePolicy /
    // grantRead on the function follow its role).
    const newExecutionRole = (name: string, opts: { vpc: boolean; xray: boolean }) => {
      const role = new iam.Role(this, `${id}-${name}`, {
        roleName: `${id}-${name}`,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            opts.vpc
              ? "service-role/AWSLambdaVPCAccessExecutionRole"
              : "service-role/AWSLambdaBasicExecutionRole"
          ),
        ],
        permissionsBoundary: requestHandlerBoundary,
      });
      if (opts.xray) {
        role.addToPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              "xray:PutTraceSegments",
              "xray:PutTelemetryRecords",
              "xray:GetSamplingRules",
              "xray:GetSamplingTargets",
            ],
            resources: ["*"],
          })
        );
      }
      return role;
    };

    const adminAuthorizerRole = newExecutionRole("adminAuthorizerRole", { vpc: true, xray: false });
    // SM_COGNITO_CREDENTIALS; the admin authorizer is the only reader of this secret.
    this.secret.grantRead(adminAuthorizerRole);
    const userAuthorizerRole = newExecutionRole("userAuthorizerRole", { vpc: false, xray: false });
    // userFunction mints anonymous credentials and public tokens (POST /user, GET /user/publicToken).
    const userFunctionRole = newExecutionRole("userFunctionRole", { vpc: true, xray: true });
    db.secretPathUser.grantRead(userFunctionRole);
    const textGenRole = newExecutionRole("textGenRole", { vpc: true, xray: true });
    db.secretPathUser.grantRead(textGenRole);
    const knowledgeBaseRole = newExecutionRole("knowledgeBaseRole", { vpc: true, xray: true });
    db.secretPathUser.grantRead(knowledgeBaseRole);
    // Shared token that authenticates lambdaKnowledgeBase self-invocations
    // (helpers/worker_envelope.py, finding f-7f03f151): main.py runs a {task}
    // payload only when it carries this value. Generated by Secrets Manager,
    // never set in code, and readable ONLY by knowledgeBaseRole, so holding
    // lambda:InvokeFunction on the function is not enough to run a worker.
    const workerInvokeSecret = new secretsmanager.Secret(this, `${id}-WorkerInvokeSecret`, {
      secretName: `${id}-KC-WorkerInvokeSecret`,
      description: "Shared token that authenticates lambdaKnowledgeBase self-invocations (helpers/worker_envelope.py)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "token",
        excludePunctuation: true,
        passwordLength: 64,
      },
    });
    workerInvokeSecret.grantRead(knowledgeBaseRole);

    const coglambdaRole = new iam.Role(
      this,
      `${id}-cognitoLambdaRole-${this.region}`,
      {
        roleName: `${id}-cognitoLambdaRole-${this.region}`,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      }
    );

    // Readwrite (DML only): the PostConfirmation trigger only upserts users rows,
    // so this role must not be able to read the DDL-capable tablecreator secret.
    db.secretPathUser.grantRead(coglambdaRole);

    // Grant access to EC2
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        resources: ["*"], // must be *
      })
    );

    // Grant access to log
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Logs
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      })
    );

    // addAdminOnSignUp.js only calls AdminListGroupsForUser, on this pool. Standalone
    // iam.Policy on purpose, NOT coglambdaRole.addToPolicy: each trigger Lambda DependsOn
    // the role's DefaultPolicy and the pool's LambdaConfig GetAtt's those Lambdas, so a
    // pool ARN in the DefaultPolicy would close UserPool -> trigger -> DefaultPolicy ->
    // UserPool. The functions do not depend on this separate policy, so the pool ARN
    // token is cycle-free.
    new iam.Policy(this, `${id}-postConfirmationGroupLookupPolicy`, {
      roles: [coglambdaRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["cognito-idp:AdminListGroupsForUser"],
          resources: [this.userPool.userPoolArn],
        }),
      ],
    });

    // Redundant secrets manager access block removed

    // Attach roles to the identity pool
    new cognito.CfnIdentityPoolRoleAttachment(this, `${id}-IdentityPoolRoles`, {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: authenticatedRole.roleArn,
        unauthenticated: unauthenticatedRole.roleArn,
      },
      // Token mapping (finding f-81bbc719): adminRole is assumed only through the
      // admin group's cognito:roles claim; a user with no group role is denied.
      roleMappings: {
        userPool: {
          identityProvider: `${this.userPool.userPoolProviderName}:${this.appClient.userPoolClientId}`,
          type: "Token",
          ambiguousRoleResolution: "Deny",
        },
      },
    });

    const jwtSecret = new secretsmanager.Secret(this, `${id}-JwtSecret`, {
      secretName: `${id}-KC-JWTSecret`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "jwtSecret",
        excludePunctuation: false,
        excludeCharacters: '"@/\\\'',
        passwordLength: 128,
      },
    });
    // iss claim of every public token (userCredential.js); each verifier checks it.
    // Not secret and not account-specific: it names this deployment.
    const jwtIssuer = `${id}/public-auth`;

    const adminAuthorizationFunction = new lambda.Function(
      this,
      `${id}-admin-authorization-api-gateway`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda/adminAuthorizerFunction"),
        handler: "adminAuthorizerFunction.handler",
        timeout: Duration.seconds(30),
        // reservedConcurrentExecutions: 100,
        vpc: vpcStack.vpc,
        environment: {
          SM_COGNITO_CREDENTIALS: this.secret.secretName,
        },
        functionName: `${id}-adminLambdaAuthorizer`,
        memorySize: 512,
        layers: [jwt],
        role: adminAuthorizerRole,
      }
    );

    // Pinned to this account's authorizers (finding f-a52b51f4): a bare grantInvoke to
    // the apigateway principal lets an API in any account invoke it. Wildcard API id,
    // like the handler permissions: Lambdas must never Ref this.api (SpecRestApi cycle).
    adminAuthorizationFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/authorizers/*`,
    });

    // --- Operational alarm notifications ---------------------------------------------
    // Every cloudwatch.Alarm in this stack notifies this topic. The subscription address is
    // the optional `alarmEmail` context value (cdk/bin/cdk.ts); no address is hard-coded.
    // Without it the topic has no subscriber and alarms are only visible in CloudWatch.
    // Self-contained: the topic takes no token from any Lambda, so no new cycle.
    const opsAlarmTopic = new sns.Topic(this, 'OpsAlarmTopic', {
      topicName: `${id}-OpsAlarms`,
      displayName: 'Knowledge Compass operational alarms',
    });
    if (props.alarmEmail) {
      opsAlarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }
    // Service publishers, each limited to this account. The first resource-policy
    // statement replaces the default topic policy, so CloudWatch alarms are granted
    // explicitly. AWS Budgets and Cost Anomaly Detection (CostStack) publish here too.
    // Same-account IAM principals still publish through their identity policies.
    opsAlarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CloudWatchAlarmsPublish',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [opsAlarmTopic.topicArn],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));
    opsAlarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'BudgetsPublish',
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [opsAlarmTopic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:${this.partition}:budgets::${this.account}:*` },
      },
    }));
    opsAlarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CostAnomalyDetectionPublish',
      principals: [new iam.ServicePrincipal('costalerts.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [opsAlarmTopic.topicArn],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));
    this.opsAlarmTopic = opsAlarmTopic;
    const opsAlarmAction = new cwActions.SnsAction(opsAlarmTopic);

    // Concurrency thresholds are re-based to 8: the account's Lambda concurrency limit
    // is 10 today. Revisit once the quota increase lands.
    new cloudwatch.Alarm(this, 'AdminAuthorizerConcurrencyAlarm', {
      metric: adminAuthorizationFunction.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 8,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Admin authorizer approaching concurrency limit',
    }).addAlarmAction(opsAlarmAction);

    const apiGW_authorizationFunction = adminAuthorizationFunction.node
      .defaultChild as lambda.CfnFunction;
    apiGW_authorizationFunction.overrideLogicalId("adminLambdaAuthorizer");

    const userAuthFunction = new lambda.Function(
      this,
      `${id}-user-authorization-api-gateway`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda/authorization"),
        handler: "userAuthorizerFunction.handler",
        timeout: Duration.seconds(30),
        memorySize: 256,
        reservedConcurrentExecutions: reservedConcurrency(50),
        layers: [jwt],
        role: userAuthorizerRole,
        environment: {
          JWT_SECRET: jwtSecret.secretArn,
          JWT_ISSUER: jwtIssuer,
        },
        functionName: `${id}-userLambdaAuthorizer`,
      }
    );
    jwtSecret.grantRead(userAuthFunction);
    // Same pinning as the admin authorizer (finding f-a52b51f4).
    userAuthFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/authorizers/*`,
    });

    new cloudwatch.Alarm(this, 'UserAuthorizerConcurrencyAlarm', {
      metric: userAuthFunction.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 8,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'User authorizer approaching concurrency limit',
    }).addAlarmAction(opsAlarmAction);

    const apiGW_userauthorizationFunction = userAuthFunction.node
      .defaultChild as lambda.CfnFunction;
    apiGW_userauthorizationFunction.overrideLogicalId("userLambdaAuthorizer");

    // GET /user/publicToken is served by userFunction (handlers/userHandler.js):
    // exchanging a credential checks its version against the users table, so
    // it needs the database. See handlers/utils/userCredential.js.

    // Staff sign-up email domains (SecureString, comma list). preSignUp
    // enforces it; userFunction refuses these domains on PUT /user/{user_id}.
    const allowedEmailDomainsParamName = "/KC/AllowedEmailDomains";

    const preSignupLambda = new lambda.Function(this, `preSignupLambda`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset("lambda/authorization"),
      handler: "preSignUp.handler",
      timeout: Duration.seconds(30),
      environment: {
        ALLOWED_EMAIL_DOMAINS: allowedEmailDomainsParamName,
      },
      vpc: vpcStack.vpc,
      functionName: `${id}-preSignupLambda`,
      memorySize: 128,
      role: coglambdaRole,
    });

    // preSignUp.js reads only this parameter (SecureString under aws/ssm).
    coglambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${allowedEmailDomainsParamName}`],
    }));

    preSignupLambda.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    preSignupLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    userAuthFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    userAuthFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    adminAuthorizationFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    adminAuthorizationFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));

    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_SIGN_UP,
      preSignupLambda
    );

    const AutoSignupLambda = new lambda.Function(
      this,
      `${id}-addAdminOnSignUp`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda/authorization"),
        handler: "addAdminOnSignUp.handler",
        timeout: Duration.seconds(30),
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        },
        vpc: vpcStack.vpc,
        functionName: `${id}-addMemberOnSignUp`,
        memorySize: 128,
        layers: [postgres],
        role: coglambdaRole,
      }
    );
    this.userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      AutoSignupLambda
    );



    // Main chat (answer) model: a US cross-region inference profile id. Same value as the
    // documented /KC/LLM/SonnetArn parameter; also the ModelId dimension of the Bedrock
    // token alarms below.
    const generationModelId = 'us.anthropic.claude-sonnet-4-6';

    const lambdaTextGen = new lambda.Function(
      this,
      `${id}-lambdaTextGen`,
      {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "main.handler",
        code: lambda.Code.fromAsset("lambda/textGeneration"),
        timeout: cdk.Duration.seconds(60),
        role: textGenRole,
        reservedConcurrentExecutions: reservedConcurrency(50),
        layers: [psycopgLayer, powertoolsLayer],
        vpc: vpcStack.vpc,
        tracing: lambda.Tracing.ACTIVE,
        memorySize: 512,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          REGION: this.region,
          LLM_REGION: this.region,
          BEDROCK_MODEL_ID: generationModelId,
          USE_PGVECTOR_RETRIEVAL: "true",
        },
      }
    )

    // Async invocations (the WebSocket default route invokes text generation as an Event)
    // must not be retried: a retry re-runs a paid Bedrock call and re-streams to the client.
    // The EventInvokeConfig only references the function, so no circular dependency is added.
    lambdaTextGen.configureAsyncInvoke({
      retryAttempts: 0,
      maxEventAge: Duration.seconds(60),
    });

    // Grant SSM parameter access for HaikuArn and SonnetArn
      lambdaTextGen.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ssm:GetParameter", "ssm:GetParameters"],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter/KC/LLM/HaikuArn`,
            `arn:aws:ssm:${this.region}:${this.account}:parameter/KC/LLM/SonnetArn`,
          ],
        })
      );

      // Add SSM parameter names as environment variables
      lambdaTextGen.addEnvironment("HAIKU_ARN", "/KC/LLM/HaikuArn");
      lambdaTextGen.addEnvironment("SONNET_ARN", "/KC/LLM/SonnetArn");


    lambdaTextGen.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions:["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/KC/LLM/HaikuArn`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/KC/LLM/SonnetArn`,
        ],
      })
    );

    // --- Bedrock Input Guardrail ---
    const guardrailConfig = {
      piiEntities: [
        // General
        'AGE', 'NAME', 'EMAIL', 'PHONE', 'USERNAME', 'PASSWORD',
        'DRIVER_ID', 'LICENSE_PLATE', 'VEHICLE_IDENTIFICATION_NUMBER',
        // Finance
        'CREDIT_DEBIT_CARD_CVV', 'CREDIT_DEBIT_CARD_EXPIRY', 'CREDIT_DEBIT_CARD_NUMBER',
        'PIN', 'INTERNATIONAL_BANK_ACCOUNT_NUMBER', 'SWIFT_CODE',
        // IT
        'IP_ADDRESS', 'MAC_ADDRESS', 'URL',
        // Canada
        'CA_HEALTH_NUMBER', 'CA_SOCIAL_INSURANCE_NUMBER',
      ],
      regexes: GUARDRAIL_REGEXES_CONFIG,
      piiInputAction: 'ANONYMIZE',
      piiInputEnabled: true,
      promptAttackStrength: 'HIGH',
      blockedInputMessaging: "Sorry, I can't help with that. I'm Knowledge Compass, here to help families navigate inclusive education in Canada.",
    };

    const inputGuardrail = new bedrock.CfnGuardrail(this, 'InputGuardrail', {
      name: `${id}-input-guardrail`,
      blockedInputMessaging: "Sorry, I can't help with that. I'm Knowledge Compass, here to help families navigate inclusive education in Canada.",
      blockedOutputsMessaging: 'Response blocked.',
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          // General
          { type: 'AGE',                        action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'NAME',                       action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'EMAIL',                      action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'PHONE',                      action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'USERNAME',                   action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'PASSWORD',                   action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'DRIVER_ID',                  action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'LICENSE_PLATE',              action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'VEHICLE_IDENTIFICATION_NUMBER', action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          // Finance
          { type: 'CREDIT_DEBIT_CARD_CVV',      action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'CREDIT_DEBIT_CARD_EXPIRY',   action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'CREDIT_DEBIT_CARD_NUMBER',   action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'PIN',                        action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'INTERNATIONAL_BANK_ACCOUNT_NUMBER', action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'SWIFT_CODE',                 action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          // IT
          { type: 'IP_ADDRESS',                 action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'MAC_ADDRESS',                action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'URL',                        action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          // Canada
          { type: 'CA_HEALTH_NUMBER',           action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
          { type: 'CA_SOCIAL_INSURANCE_NUMBER', action: 'ANONYMIZE', inputAction: 'ANONYMIZE', inputEnabled: true },
        ],
        regexesConfig: GUARDRAIL_REGEXES_CONFIG,
      },
      contentPolicyConfig: {
        filtersConfig: [
          // outputStrength must be NONE: AWS applies PROMPT_ATTACK to user input only, and this guardrail is applied with source='INPUT' only.
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
    });

    const configHash = computeConfigHash(guardrailConfig);
    cdk.Tags.of(inputGuardrail).add('ConfigHash', configHash);

    const inputGuardrailVersion = new bedrock.CfnGuardrailVersion(this, `InputGuardrailVersion-${configHash.substring(0, 8)}`, {
      guardrailIdentifier: inputGuardrail.attrGuardrailId,
      description: `Config hash: ${configHash.substring(0, 8)}`,
    });

    lambdaTextGen.addEnvironment('GUARDRAIL_ID', inputGuardrail.attrGuardrailId);
    lambdaTextGen.addEnvironment('GUARDRAIL_VERSION', inputGuardrailVersion.attrVersion);

    lambdaTextGen.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:ApplyGuardrail'],
      resources: [inputGuardrail.attrGuardrailArn],
    }));

    // Override the Logical ID
    const cfnlambdaTextGen = lambdaTextGen.node
      .defaultChild as lambda.CfnFunction;
    cfnlambdaTextGen.overrideLogicalId("lambdaTextGen");

    // API Gateway permissions

    lambdaTextGen.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/*/chat_sessions*`,
    });

    new cloudwatch.Alarm(this, 'TextGenConcurrencyAlarm', {
      metric: lambdaTextGen.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 8,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Text Generation Lambda approaching concurrency limit',
    }).addAlarmAction(opsAlarmAction);

    // --- Usage and abuse alarms ------------------------------------------------------
    // Thresholds are starting values pending decision D4; tune them from real traffic.
    // All metrics here are referenced by namespace/name/dimension or come from constructs
    // this stack already depends on (lambdaTextGen, the REST API, the db prop), so no new
    // cycle is introduced.

    // Bedrock throttles, all models. AWS/Bedrock publishes runtime metrics both with and
    // without the ModelId dimension, and requests that fail before a model is resolved only
    // appear without it, so the dimensionless series is the complete count.
    new cloudwatch.Alarm(this, 'BedrockInvocationThrottlesAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'InvocationThrottles',
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Amazon Bedrock throttled at least one model invocation in 5 minutes; chat answers may be failing',
    }).addAlarmAction(opsAlarmAction);

    // Hourly token usage of the main chat model (dominant Bedrock cost). The dimension value
    // is the inference profile id the Lambda passes as modelId.
    new cloudwatch.Alarm(this, 'BedrockInputTokensHourlyAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'InputTokenCount',
        dimensionsMap: { ModelId: generationModelId },
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.hours(1),
      }),
      threshold: 2_000_000,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `More than 2,000,000 input tokens in one hour on ${generationModelId}; check for abuse or runaway usage`,
    }).addAlarmAction(opsAlarmAction);

    new cloudwatch.Alarm(this, 'BedrockOutputTokensHourlyAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'OutputTokenCount',
        dimensionsMap: { ModelId: generationModelId },
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.hours(1),
      }),
      threshold: 250_000,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `More than 250,000 output tokens in one hour on ${generationModelId}; check for abuse or runaway usage`,
    }).addAlarmAction(opsAlarmAction);

    new cloudwatch.Alarm(this, 'TextGenInvocationsAlarm', {
      metric: lambdaTextGen.metricInvocations({
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 100,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Text Generation Lambda invoked more than 100 times in 5 minutes; check for a chat flood',
    }).addAlarmAction(opsAlarmAction);

    // REST API server errors (ApiName dimension is the plain restApiName string).
    new cloudwatch.Alarm(this, 'RestApi5XXErrorAlarm', {
      metric: this.api.metricServerError({
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'REST API returned more than 5 server (5XX) errors in 5 minutes',
    }).addAlarmAction(opsAlarmAction);

    // WAF blocks across all rules. The WebACL dimension is the web ACL's metric name.
    new cloudwatch.Alarm(this, 'WafBlockedRequestsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        dimensionsMap: { WebACL: 'KC-firewall', Region: this.region, Rule: 'ALL' },
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 100,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'WAF blocked more than 100 requests in 5 minutes; possible attack or a rule blocking real users',
    }).addAlarmAction(opsAlarmAction);

    // RDS connections, from the db prop (a cross-stack metric, not a Lambda reference).
    // db.t4g.medium allows roughly 400 connections by default.
    new cloudwatch.Alarm(this, 'DatabaseConnectionsAlarm', {
      metric: db.dbInstance.metricDatabaseConnections({
        statistic: cloudwatch.Stats.MAXIMUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 300,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'RDS database connections above 300 for 10 minutes; check RDS Proxy pooling and Lambda concurrency',
    }).addAlarmAction(opsAlarmAction);

    // The embedding-space consistency check in textGeneration (helpers/embedding_space.py)
    // writes this metric as a CloudWatch Embedded Metric Format log line, so no
    // PutMetricData permission is needed. The metric is referenced by namespace and
    // name only (no token to lambdaTextGen, which would risk a circular dependency).
    // The alarm action (SNS) is attached below, once the lifecycle notification topic exists.
    const embeddingSpaceCheckFailedAlarm = new cloudwatch.Alarm(this, 'EmbeddingSpaceCheckFailedAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'KnowledgeCompass/Embeddings',
        metricName: 'EmbeddingSpaceCheckFailed',
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The active embedding space failed its startup/refresh consistency check; chat returns EMBEDDING_SPACE_UNAVAILABLE until it is fixed or rolled back',
    });

    // The knowledge-base Lambda's cutover job (helpers/cutover.py) writes this metric the same
    // way (CloudWatch Embedded Metric Format on stdout), so no PutMetricData permission is added
    // to the knowledge-base role. It fires when the golden-set check after a pointer flip fails.
    // The job does NOT roll back by itself: the alarm tells the operator to review and use the
    // Rollback action. Referenced by namespace/name only (no token to lambdaKnowledgeBase, which
    // would recreate the documented circular dependency). The SNS action is attached with the
    // notification topic, below.
    const postFlipCheckFailedAlarm = new cloudwatch.Alarm(this, 'PostFlipCheckFailedAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'KnowledgeCompass/Embeddings',
        metricName: 'PostFlipCheckFailed',
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The golden-set check after an embedding-space cutover failed; the new space is live. Review the job report and use Rollback in the admin Search index page if retrieval quality dropped',
    });

    // --- Model lifecycle guardrail ---------------------------------------------------
    // A weekly Lambda (lambda/lifecycleCheck) lists the Bedrock models the system depends on
    // (non-purged embedding spaces + the /KC/LLM generation parameters) and publishes ONE
    // message to this topic when a model is not ACTIVE, is missing, or reaches end of life
    // within 90 days. The same topic is the action of the two embedding alarms above.
    //
    // Circular-dependency note: everything here is NEW and self-contained. The function has its
    // OWN role (not the shared lambdaRole), and the alarms reference the topic only; nothing
    // takes a token from lambdaKnowledgeBase or lambdaTextGen. No stack output is exported.
    const lifecycleTopic = new sns.Topic(this, 'ModelLifecycleAlerts', {
      topicName: `${id}-ModelLifecycleAlerts`,
      displayName: 'Knowledge Compass model lifecycle alerts',
    });

    // TODO(CIC): alert channel/endpoint placeholder. No address is hard-coded. Until CIC names
    // the channel (email list, chat webhook via AWS Chatbot, pager), the topic exists but has no
    // subscriber, so alerts are only visible in CloudWatch. Subscribe an address with
    //   cdk deploy -c lifecycleAlertEmail=<address>
    // or keep it out of the command line with
    //   cdk deploy -c lifecycleAlertEmailParam=<name of an SSM String parameter holding the address>
    const lifecycleAlertEmail = this.node.tryGetContext('lifecycleAlertEmail');
    const lifecycleAlertEmailParam = this.node.tryGetContext('lifecycleAlertEmailParam');
    if (lifecycleAlertEmail) {
      lifecycleTopic.addSubscription(new subscriptions.EmailSubscription(String(lifecycleAlertEmail)));
    } else if (lifecycleAlertEmailParam) {
      lifecycleTopic.addSubscription(
        new subscriptions.EmailSubscription(
          ssm.StringParameter.valueForStringParameter(this, String(lifecycleAlertEmailParam)),
        ),
      );
    }

    embeddingSpaceCheckFailedAlarm.addAlarmAction(new cwActions.SnsAction(lifecycleTopic));
    postFlipCheckFailedAlarm.addAlarmAction(new cwActions.SnsAction(lifecycleTopic));
    // Also notify the operational topic, so one `alarmEmail` subscriber sees every alarm.
    embeddingSpaceCheckFailedAlarm.addAlarmAction(opsAlarmAction);
    postFlipCheckFailedAlarm.addAlarmAction(opsAlarmAction);

    // Own role, least privilege. bedrock:ListFoundationModels has no resource-level scoping.
    // The two SSM parameters are the generation-model names the app already reads
    // (/KC/LLM/HaikuArn, /KC/LLM/SonnetArn); this is the only SSM access.
    const lifecycleRole = new iam.Role(this, `${id}-lifecycleCheckRole`, {
      roleName: `${id}-lifecycleCheckRole`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      // VPC network interfaces plus CloudWatch Logs.
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    lifecycleRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:ListFoundationModels'],
      resources: ['*'],
    }));
    lifecycleRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sns:Publish'],
      resources: [lifecycleTopic.topicArn],
    }));
    lifecycleRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [db.secretPathUser.secretArn],
    }));
    lifecycleRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/KC/LLM/HaikuArn`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/KC/LLM/SonnetArn`,
      ],
    }));

    // Same VPC (default private-with-egress subnets, like lambdaKnowledgeBase, which the
    // database security group already admits) and psycopg2 layer. The VPC has a NAT gateway, so
    // the Bedrock control-plane call is reachable; confirm on first deploy by invoking the
    // function once and reading its log.
    const lifecycleCheckFunction = new lambda.Function(this, `${id}-lifecycleCheck`, {
      functionName: `${id}-lifecycleCheck`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'main.handler',
      code: lambda.Code.fromAsset('lambda/lifecycleCheck'),
      timeout: Duration.seconds(120),
      memorySize: 256,
      role: lifecycleRole,
      layers: [psycopgLayer],
      vpc: vpcStack.vpc,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        REGION: this.region,
        SNS_TOPIC_ARN: lifecycleTopic.topicArn,
        GENERATION_MODEL_PARAMS: '/KC/LLM/HaikuArn,/KC/LLM/SonnetArn',
      },
    });

    new events.Rule(this, 'ModelLifecycleWeeklyRule', {
      ruleName: `${id}-ModelLifecycleWeekly`,
      description: 'Weekly check of the Bedrock models in use (end of life, status)',
      schedule: events.Schedule.rate(Duration.days(7)),
      targets: [new targets.LambdaFunction(lifecycleCheckFunction)],
    });

    lambdaTextGen.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    // Methods this function serves (OpenAPI_Swagger_Definition.yaml), for CORS.
    lambdaTextGen.addEnvironment('CORS_ALLOWED_METHODS', 'POST');
    lambdaTextGen.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));

    // Public chat kill switch: set to "false" to pause public chat (textGeneration
    // refuses new turns with PUBLIC_CHAT_PAUSED; read is cached 60 s and fails open).
    // CloudFormation only rewrites the value when the template value changes, so a
    // manual flip survives normal deploys. The name and ARN are plain strings (no
    // token references), matching the AllowedOrigins pattern above.
    const publicChatEnabledParamName = `/${id}/PublicChatEnabled`;
    new ssm.StringParameter(this, 'PublicChatEnabledParam', {
      parameterName: publicChatEnabledParamName,
      stringValue: 'true',
      description: 'Public chat kill switch: "false" pauses public chat',
    });
    lambdaTextGen.addEnvironment('PUBLIC_CHAT_ENABLED_PARAM', publicChatEnabledParamName);
    lambdaTextGen.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${publicChatEnabledParamName}`],
    }));


    AutoSignupLambda.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    AutoSignupLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    // Bedrock permissions
    const textGenBedrockPolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "bedrock:GetInferenceProfile",
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream", // Add streaming permission
        "bedrock:Converse",
        "bedrock:ConverseStream",
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-english-v3`,
        `arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-english-v3`,
        // Candidate embedding models. Model ids / inference-profile ARNs are
        // configuration on the embedding_spaces row; these grants enable
        // candidates and do not assert availability in this region. Wildcard
        // region on the foundation-model ARNs covers the destination regions of
        // cross-region profiles. Manual ARNs on purpose (no CDK token
        // references; see the documented circular-dependency notes).
        `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/*amazon.titan-embed-text-v2*`,
        // Cohere Embed v4 (model id suffix not verified: grant both forms)
        `arn:aws:bedrock:*::foundation-model/cohere.embed-v4`,
        `arn:aws:bedrock:*::foundation-model/cohere.embed-v4:0`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/*cohere.embed-v4*`,
        // Claude Sonnet 4.6 (Converse currently resolves this model in us-west-2)
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`,
        // Claude Haiku 4.5 (Converse currently resolves this model in us-west-2)
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
      ],
    });
    lambdaTextGen.addToRolePolicy(textGenBedrockPolicyStatement);

    // textGenRole reads db.secretPathUser (granted where the role is created).



    // --- Knowledge Base Lambda Function ---
    const lambdaKnowledgeBase = new lambda.Function(this, `${id}-lambdaKnowledgeBase`, {
      functionName: `${id}-lambdaKnowledgeBase`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "main.handler",
      // pypdf/python-docx (the PDF fallback in helpers/pdf_text.py and DOCX
      // text extraction in helpers/process_document_batch.py) are vendored
      // directly into lambda/knowledgeBase/ as prebuilt
      // manylinux wheels (see requirements.txt) rather than pip-installed via
      // Docker bundling, so deploying this stack has no Docker dependency —
      // consistent with the rest of this zip-asset Lambda (boto3 from the
      // runtime, psycopg2 from psycopgLayer).
      code: lambda.Code.fromAsset("lambda/knowledgeBase"),
      // 600s (vs. the previous 300s): the pgvector document-ingestion worker
      // (helpers/process_document_batch.py) runs via an async self-invocation,
      // not behind API Gateway's 29s limit, so it needs headroom to chunk +
      // embed larger CSV/Markdown uploads. Synchronous routes are unaffected.
      // Textract OCR waits are budgeted against this from the Lambda context;
      // work that doesn't fit continues in a fresh self-invocation.
      timeout: Duration.seconds(600),
      role: knowledgeBaseRole,
      layers: [psycopgLayer],
      memorySize: 512,
      vpc: vpcStack.vpc,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        REGION: this.region,
        LAMBDA_FUNCTION_NAME: `${id}-lambdaKnowledgeBase`,
        // Invoke token for self-invocations (helpers/worker_envelope.py).
        WORKER_INVOKE_SECRET_ARN: workerInvokeSecret.secretArn,
        // PDF text extraction (helpers/pdf_text.py): "always" reads every PDF
        // with Amazon Textract, "auto" only PDFs without a usable text layer
        // (scans, image-only exports), "off" uses pypdf alone.
        PDF_TEXTRACT_MODE: "always",
        // Guideline mode (helpers/guideline_document.py) labels each section
        // of an uploaded guide with Haiku. Same SSM parameter name contract as
        // lambdaTextGen; LLM_REGION matches lambdaTextGen's.
        HAIKU_ARN: "/KC/LLM/HaikuArn",
        LLM_REGION: this.region,
      },
    });

    // Amazon Textract document analysis for PDF ingestion (helpers/pdf_text.py):
    // AnalyzeDocument for single-page PDFs, Start/GetDocumentAnalysis for the
    // rest. These actions have no resource-level permissions. Textract reads
    // the ingest-bucket objects with this role's own S3 access
    // (grantBucketAccess below), so no Textract service role is needed. Like
    // the other statements here, this lands on the dedicated knowledgeBaseRole.
    lambdaKnowledgeBase.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "textract:AnalyzeDocument",
        "textract:StartDocumentAnalysis",
        "textract:GetDocumentAnalysis",
      ],
      resources: ["*"],
    }));

    lambdaKnowledgeBase.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    // Methods this function serves (OpenAPI_Swagger_Definition.yaml), for CORS.
    lambdaKnowledgeBase.addEnvironment('CORS_ALLOWED_METHODS', 'DELETE,GET,PATCH,POST,PUT');
    lambdaKnowledgeBase.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));

    // Bedrock for the knowledge base: embeddings (Cohere v3 and the candidate
    // embedding models) and Haiku Converse for guideline-mode labelling. It used
    // to get these through the role shared with lambdaTextGen; with its own role
    // it needs the statement explicitly. Same statement object, plain ARNs.
    lambdaKnowledgeBase.addToRolePolicy(textGenBedrockPolicyStatement);

    // Search-index registration asks the Bedrock control plane which embedding
    // models this account can call, and which id or inference-profile ARN to
    // store. Both actions are account-wide (no resource-level scoping).
    lambdaKnowledgeBase.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"],
      resources: ["*"],
    }));

    // Guideline-mode section labelling reads the Haiku model id from SSM and
    // calls Converse (Bedrock statement above). Plain ARN strings, no token
    // references back to the function (see the circular-dependency note below).
    lambdaKnowledgeBase.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/KC/LLM/HaikuArn`],
    }));

    // Self-invoke permission for the async document-ingestion worker
    // (trigger_document_batch -> lambda_client.invoke(InvocationType="Event")).
    // Uses a manually-built ARN (not lambdaKnowledgeBase.functionArn): the
    // function DependsOn its role's DefaultPolicy (auto-added by
    // addToRolePolicy), so a live Fn::GetAtt reference back to
    // lambdaKnowledgeBase in that policy would be a circular dependency that
    // fails changeset creation. This holds with the dedicated knowledgeBaseRole too.
    // IAM is not the only gate: every self-invoke payload must also carry the
    // invoke_token from workerInvokeSecret (helpers/worker_envelope.py).
    lambdaKnowledgeBase.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["lambda:InvokeFunction"],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${id}-lambdaKnowledgeBase`],
    }));

    // pgvector ingestion wiring (R12): when the IngestionStack is provided, set
    // the ECS cluster/taskdef/subnet/SG env, and grant ecs:RunTask + iam:PassRole
    // so process_crawler_batch.py can launch tasks.
    if (props.ingestion) {
      const ingestionEnv = props.ingestion.ingestionEnv();
      for (const [key, value] of Object.entries(ingestionEnv)) {
        lambdaKnowledgeBase.addEnvironment(key, value);
      }
      props.ingestion.grantRunTasks(lambdaKnowledgeBase);
      props.ingestion.grantBucketAccess(lambdaKnowledgeBase);
    }


    const cfnLambdaKnowledgeBase = lambdaKnowledgeBase.node.defaultChild as lambda.CfnFunction;
    cfnLambdaKnowledgeBase.overrideLogicalId("lambdaKnowledgeBase");

    lambdaKnowledgeBase.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/*/admin/*`,
    });

    // userFunctionRole reads db.secretPathUser (granted where the role is created).

    const lambdaUserFunction = new lambda.Function(this, `${id}-userFunction`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset("lambda"),
      handler: "handlers/userHandler.handler",
      timeout: Duration.seconds(30),
      vpc: vpcStack.vpc,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        USER_POOL: this.userPool.userPoolId,
        // Signs anonymous users' credentials (POST /user) and access tokens
        // (GET /user/publicToken).
        JWT_SECRET: jwtSecret.secretArn,
        JWT_ISSUER: jwtIssuer,
      },
      functionName: `${id}-userFunction`,
      memorySize: 512,
      reservedConcurrentExecutions: reservedConcurrency(25),
      layers: [postgres, jwt],
      role: userFunctionRole,
      tracing: lambda.Tracing.ACTIVE,
    });
    jwtSecret.grantRead(lambdaUserFunction);

    // userFunction also serves the unauthenticated GET /user/publicToken
    // (stage-throttled and WAF rate-limited); watch for floods.
    new cloudwatch.Alarm(this, 'UserFunctionConcurrencyAlarm', {
      metric: lambdaUserFunction.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 8,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'User Lambda (incl. public token exchange) approaching concurrency limit',
    }).addAlarmAction(opsAlarmAction);

    lambdaUserFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaUserFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));

    // PUT /user/{user_id} refuses staff sign-up domains (handlers/utils/staffEmailDomains.js).
    // SecureString under the AWS-managed aws/ssm key, so no KMS grant is needed.
    lambdaUserFunction.addEnvironment('ALLOWED_EMAIL_DOMAINS', allowedEmailDomainsParamName);
    lambdaUserFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${allowedEmailDomainsParamName}`],
    }));


    lambdaUserFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/*/member*`,
    });

    //Allows Invoking Functions Easily for Testing Purposes
    lambdaUserFunction.addPermission("AllowTestInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/test-invoke-stage/*/*`,
    });

    const cfnLambda_user = lambdaUserFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_user.overrideLogicalId("userFunction");

    lambdaUserFunction.addPermission("AllowAdminApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/*/user*`,
    });

    const lambdaSystemMessagesFunction = new lambda.Function(this, `${id}-systemMessagesFunction`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset("lambda"),
      handler: "handlers/systemMessagesHandler.handler",
      timeout: Duration.seconds(30),
      vpc: vpcStack.vpc,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        USER_POOL: this.userPool.userPoolId,
      },
      functionName: `${id}-systemMessagesFunction`,
      memorySize: 512,
      layers: [postgres],
      role: lambdaRole,
      tracing: lambda.Tracing.ACTIVE,
    });

    lambdaSystemMessagesFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaSystemMessagesFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    lambdaSystemMessagesFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/*/member*`,
    });

    lambdaSystemMessagesFunction.addPermission("AllowTestInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/test-invoke-stage/*/*`,
    });

    const cfnLambda_systemMessages = lambdaSystemMessagesFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_systemMessages.overrideLogicalId("systemMessagesFunction");

    lambdaSystemMessagesFunction.addPermission("AllowAdminApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/*/system*`,
    });


    const lambdaChatSessionFunction = new lambda.Function(
      this,
      `${id}-chatSessionFunction`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda"),
        handler: "handlers/chatSessionHandler.handler",
        timeout: Duration.seconds(30),
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        },
        functionName: `${id}-chatSessionFunction`,
        memorySize: 512,
        reservedConcurrentExecutions: reservedConcurrency(25),
        layers: [postgres],
        role: lambdaRole,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    // Allow API Gateway to invoke for shared chat endpoints (public access)
    lambdaChatSessionFunction.addPermission("AllowApiGatewayInvokeShared", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/*/chat_sessions*`,
    });

    lambdaChatSessionFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaChatSessionFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));

    // Evaluation-harness session tags (handlers/utils/evalTag.js). Read-only
    // access to the one signing secret; "-??????" is the random suffix Secrets
    // Manager appends to secret ARNs. Note: this function uses the shared
    // postgres lambdaRole (which reads the DB user secret), so the grant lands
    // on that role; only chatSessionHandler reads the secret.
    if (props.evalSigningSecretName) {
      lambdaChatSessionFunction.addEnvironment("EVAL_SIGNING_SECRET_NAME", props.evalSigningSecretName);
      lambdaChatSessionFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${props.evalSigningSecretName}-??????`,
        ],
      }));
    }


    const cfnLambda_chatSession = lambdaChatSessionFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_chatSession.overrideLogicalId("chatSessionFunction");

    const lambdaAdminFunction = new lambda.Function(
      this,
      `${id}-adminFunction`,
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambda.Code.fromAsset("lambda"),
        handler: "handlers/adminHandler.handler",
        timeout: Duration.seconds(30),
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,

        },
        functionName: `${id}-adminFunction`,
        memorySize: 512,
        layers: [postgres],
        role: lambdaRole,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    lambdaAdminFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/*/admin*`,
    });

    lambdaAdminFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    lambdaAdminFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    //allows invoking admin Lambda from API Gateway test stage for easier testing
    lambdaAdminFunction.addPermission("AllowTestInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/test-invoke-stage/*/*`,
    });

    const cfnLambda_admin = lambdaAdminFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_admin.overrideLogicalId("adminFunction");

    // Define WebSocket API and related resources directly in ApiGatewayStack
    this.webSocketApi = new apigatewayv2.WebSocketApi(
      this,
      `${id}-ChatWebSocketApi`,
      {
        apiName: `${id}-chat-websocket`,
      }
    );

    // connectionId -> verified anonymous user id, written by $connect, read by $default.
    // TTL is past API Gateway's 2h connection limit; $disconnect deletes it earlier.
    const wsConnectionsTable = new dynamodb.Table(this, `${id}-WsConnections`, {
      partitionKey: { name: "connectionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: cdk.RemovalPolicy.DESTROY, // short-lived connection state only
    });

    // Connect Lambda
    const connectFunction = new lambda.Function(this, `${id}-ConnectFunction`, {
      functionName: `${id}-ConnectFunction`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "connect.handler",
      code: lambda.Code.fromAsset("lambda/websocket"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: reservedConcurrency(50),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        JWT_SECRET: jwtSecret.secretArn,
        JWT_ISSUER: jwtIssuer,
      },
      layers: [jwt],
    });

    new cloudwatch.Alarm(this, 'ConnectFunctionConcurrencyAlarm', {
      metric: connectFunction.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 8,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'WebSocket Connect Lambda approaching concurrency limit',
    }).addAlarmAction(opsAlarmAction);

    connectFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    connectFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    // Disconnect Lambda
    const disconnectFunction = new lambda.Function(
      this,
      `${id}-DisconnectFunction`,
      {
        functionName: `${id}-DisconnectFunction`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "disconnect.handler",
        code: lambda.Code.fromAsset("lambda/websocket"),
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    // Default route Lambda for handling messages.
    // Private subnets (the database security group already admits them) so each
    // frame can be truncated to system_settings.max_characters_per_user_message
    // (websocket/messageLimit.js) instead of a hard-coded length.
    const defaultFunction = new lambda.Function(this, `${id}-DefaultFunction`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "default.handler",
      code: lambda.Code.fromAsset("lambda/websocket"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: reservedConcurrency(50),
      tracing: lambda.Tracing.ACTIVE,
      vpc: vpcStack.vpc,
      environment: {
        TEXT_GEN_FUNCTION_NAME: lambdaTextGen.functionName,
        // Each generate_text message's access token is verified here.
        JWT_SECRET: jwtSecret.secretArn,
        JWT_ISSUER: jwtIssuer,
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
      },
      layers: [jwt, postgres],
      functionName: `${id}-DefaultFunction`,
    });
    jwtSecret.grantRead(defaultFunction);
    db.secretPathUser.grantRead(defaultFunction);

    new cloudwatch.Alarm(this, 'DefaultFunctionConcurrencyAlarm', {
      metric: defaultFunction.metric('ConcurrentExecutions', { statistic: cloudwatch.Stats.MAXIMUM }),
      threshold: 8,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'WebSocket Default Lambda approaching concurrency limit',
    }).addAlarmAction(opsAlarmAction);

    defaultFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    defaultFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    disconnectFunction.addEnvironment('ALLOWED_ORIGIN_PARAM', this.allowedOriginsParamName);
    disconnectFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.allowedOriginsParamName}`],
    }));


    // Grant permissions to post to connections
    const wsPolicy = new iam.PolicyStatement({
      actions: ["execute-api:ManageConnections"],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:*/*/@connections/*`,
      ],
    });

    lambdaTextGen.addToRolePolicy(wsPolicy);
    connectFunction.addToRolePolicy(wsPolicy);
    disconnectFunction.addToRolePolicy(wsPolicy);
    // defaultFunction gets a statement scoped to this API's stage below.

    // Connection binding store: each function gets only the one action it uses.
    // Each has its own role (no shared `role:`), so these grants stay per function.
    for (const fn of [connectFunction, disconnectFunction, defaultFunction]) {
      fn.addEnvironment("CONNECTIONS_TABLE_NAME", wsConnectionsTable.tableName);
    }
    wsConnectionsTable.grant(connectFunction, "dynamodb:PutItem");
    wsConnectionsTable.grant(disconnectFunction, "dynamodb:DeleteItem");
    wsConnectionsTable.grant(defaultFunction, "dynamodb:GetItem");

    // Anonymous surface: the WebSocket functions' auto-created roles carry the same
    // boundary as the request-handling roles above.
    for (const fn of [connectFunction, disconnectFunction, defaultFunction]) {
      iam.PermissionsBoundary.of(fn).apply(requestHandlerBoundary);
    }

    jwtSecret.grantRead(connectFunction);
    // Grant the default function permission to invoke the text generation function
    lambdaTextGen.grantInvoke(defaultFunction);

    // Routes
    // No API Gateway authorizer on these routes, deliberately. lambda/websocket/connect.js
    // verifies the access token (Sec-WebSocket-Protocol "kc.v1, <token>" or Bearer),
    // echoes the subprotocol and writes the connectionId -> user binding; default.js
    // enforces that binding and re-verifies the frame token on every message. An
    // authorizer could not echo the subprotocol or write the binding, so it would only
    // add a second copy of the verification.
    new apigatewayv2.WebSocketRoute(this, `${id}-ConnectRoute`, {
      webSocketApi: this.webSocketApi,
      routeKey: "$connect",
      integration: new WebSocketLambdaIntegration(
        `${id}-ConnectIntegration`,
        connectFunction
      ),
    });

    new apigatewayv2.WebSocketRoute(this, `${id}-DisconnectRoute`, {
      webSocketApi: this.webSocketApi,
      routeKey: "$disconnect",
      integration: new WebSocketLambdaIntegration(
        `${id}-DisconnectIntegration`,
        disconnectFunction
      ),
    });

    new apigatewayv2.WebSocketRoute(this, `${id}-DefaultRoute`, {
      webSocketApi: this.webSocketApi,
      routeKey: "$default",
      integration: new WebSocketLambdaIntegration(
        `${id}-DefaultIntegration`,
        defaultFunction
      ),
    });

    // Create CloudWatch Log Group for WebSocket access logs
    const wsAccessLogGroup = new logs.LogGroup(
      this,
      `${id}-WebSocketAccessLogs`,
      {
        retention: apiLogRetention,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        encryptionKey: apiLogsKey,
        dataProtectionPolicy: apiLogDataProtection,
      }
    );

    // Stage (using CfnStage to enable access log settings for WebSocket API)
    this.wsStage = new apigatewayv2.CfnStage(this, `${id}-ProdCfnStage`, {
      apiId: this.webSocketApi?.apiId,
      stageName: "prod",
      autoDeploy: true,
      // Stage-wide backstop against anonymous message floods (all routes, all clients).
      defaultRouteSettings: {
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
        // Explicit: data trace would log the client frames.
        dataTraceEnabled: false,
      },
      accessLogSettings: {
        destinationArn: wsAccessLogGroup.logGroupArn,
        // No $context.message: the client frame holds the visitor's question and
        // token, so it is never logged. No $context.authorizer.* either: this API has
        // no API Gateway authorizer (websocket/connect.js verifies the token itself),
        // so those fields would always be empty. `ip` (same key as the REST access
        // log) lets abuse on the socket be traced to a client and matched to WAF logs.
        format: JSON.stringify({
          requestId: "$context.requestId",
          ip: "$context.identity.sourceIp",
          requestTime: "$context.requestTime",
          routeKey: "$context.routeKey",
          connectionId: "$context.connectionId",
          status: "$context.status",
        }),
      },
    });

    this.wsStage.node.addDependency(apiGatewayAccount);

    // $default posts error events and closes sockets that have no connection record
    // (DeleteConnection), on this API's stage only. Same manual ARN template as wsPolicy
    // above; the only token is this WebSocket API's own id. The Api resource references
    // nothing, so this adds no cycle (lambdaTextGen gets no new reference; see note below).
    defaultFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["execute-api:ManageConnections"],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.apiId}/${this.wsStage.stageName}/POST/@connections/*`,
        `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.apiId}/${this.wsStage.stageName}/DELETE/@connections/*`,
      ],
    }));

    // Do not put webSocketApi.apiEndpoint on lambdaTextGen (or any OpenAPI
    // Lambda). Text gen already builds the management URL from requestContext.
    // A CFN Ref from lambdaTextGen back to this WebSocket API is what closed
    // the KC-Api circular dependency (RestApi → lambdaTextGen → WebSocket
    // → defaultFunction → lambdaTextGen).

    // Add WebSocket URL as stack output
    new cdk.CfnOutput(this, "WebSocketUrl", {
      value: this.webSocketApi.apiEndpoint,
      description: "WebSocket URL for real-time streaming",
      exportName: `${id}-WebSocketUrl`,
    });

  }
}


