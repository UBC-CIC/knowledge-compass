import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/**
 * Evaluation harness infrastructure (evals/). Deployed only with
 * `-c enableEval=true` (cdk/bin/cdk.ts).
 *
 *   - Signing secret: HMAC key for eval session tags. The chat session Lambda
 *     reads it by name (ApiGatewayStack grants that by a hand-built ARN, so
 *     there is no cross-stack reference); without this stack, tag
 *     verification fails closed and every session is a normal one.
 *   - Results bucket + Bedrock evaluation service role (EvalJobResources):
 *     input/ holds the JSONL datasets, output/ the evaluation job results.
 *     Created here when the evaluation jobs run in this stack's Region,
 *     otherwise in a separate EvalJobsStack in that Region.
 */

/** Name of the signing secret; shared with ApiGatewayStack and evals/. */
export const evalSigningSecretName = (stackPrefix: string) => `${stackPrefix}/eval/signing-secret`;

/** Geo prefixes of Bedrock cross-Region inference profile ids. */
const PROFILE_PREFIX = /^(us|eu|apac|ca|jp|au|us-gov|global)\./;

export interface EvalJobResourcesProps {
  /** Judge model ids or inference profile ids the evaluation role may invoke. */
  judgeModelIds: string[];
  /** Days to keep datasets and results. */
  retentionDays?: number;
}

export class EvalJobResources extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: EvalJobResourcesProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const retention = Duration.days(props.retentionDays ?? 30);

    const accessLogs = new s3.Bucket(this, "ResultsAccessLogs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: "ExpireAccessLogs", expiration: Duration.days(90) }],
    });

    // Transcripts quote the assistant's replies to synthetic personas; keep
    // them only as long as a review needs.
    this.bucket = new s3.Bucket(this, "ResultsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: "results-access-logs/",
      lifecycleRules: [
        {
          id: "ExpireEvalArtifacts",
          expiration: retention,
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    this.role = new iam.Role(this, "EvaluationRole", {
      description: "Assumed by Amazon Bedrock to run evaluation jobs for evals/",
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
          ArnLike: {
            "aws:SourceArn": `arn:aws:bedrock:${stack.region}:${stack.account}:evaluation-job/*`,
          },
        },
      }),
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadDatasets",
        actions: ["s3:GetObject"],
        resources: [this.bucket.arnForObjects("input/*")],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteResults",
        actions: ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
        resources: [this.bucket.arnForObjects("output/*")],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ListEvalPrefixes",
        actions: ["s3:ListBucket", "s3:GetBucketLocation"],
        resources: [this.bucket.bucketArn],
      }),
    );

    // Judge models only. A cross-Region profile needs the profile in this
    // Region plus its foundation model in every Region it routes to.
    const modelResources = props.judgeModelIds.flatMap((modelId) => {
      const baseId = modelId.replace(PROFILE_PREFIX, "");
      const resources = [`arn:aws:bedrock:*::foundation-model/${baseId}`];
      if (baseId !== modelId) {
        resources.push(`arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`);
      }
      return resources;
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeJudgeModels",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: modelResources,
      }),
    );
    const profileArns = modelResources.filter((arn) => arn.includes(":inference-profile/"));
    if (profileArns.length > 0) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          sid: "ReadJudgeProfiles",
          actions: ["bedrock:GetInferenceProfile"],
          resources: profileArns,
        }),
      );
    }

    new cdk.CfnOutput(scope, "EvalResultsBucketName", { value: this.bucket.bucketName });
    new cdk.CfnOutput(scope, "EvalEvaluationRoleArn", { value: this.role.roleArn });
    new cdk.CfnOutput(scope, "EvalJobRegion", { value: stack.region });
  }
}

export interface EvalStackProps extends cdk.StackProps {
  stackPrefix: string;
  judgeModelIds: string[];
  /** Create the bucket and role in this stack (jobs run in this Region). */
  includeJobResources: boolean;
}

export class EvalStack extends cdk.Stack {
  public readonly signingSecret: secretsmanager.Secret;
  public readonly jobResources?: EvalJobResources;

  constructor(scope: Construct, id: string, props: EvalStackProps) {
    super(scope, id, props);

    // Generated value only; never set in code. Rotated every 90 days by
    // lambda/appSecretRotation, which keeps the outgoing key as
    // previousSigningKey; the API verifies tags against both (evalTag.js).
    this.signingSecret = new secretsmanager.Secret(this, "SigningSecret", {
      secretName: evalSigningSecretName(props.stackPrefix),
      description: "HMAC key that signs evaluation-harness session tags (evals/)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "signingKey",
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Never on deploy, so a rotation cannot run before the two-key verifier is live.
    this.signingSecret.addRotationSchedule("SigningSecretRotation", {
      rotationLambda: new lambda.Function(this, "SigningSecretRotationFunction", {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "index.handler",
        code: lambda.Code.fromAsset("lambda/appSecretRotation"),
        timeout: Duration.seconds(30),
        memorySize: 128,
      }),
      automaticallyAfter: Duration.days(90),
      rotateImmediatelyOnUpdate: false,
    });

    new cdk.CfnOutput(this, "EvalSigningSecretName", { value: this.signingSecret.secretName });

    if (props.includeJobResources) {
      this.jobResources = new EvalJobResources(this, "Jobs", { judgeModelIds: props.judgeModelIds });
    }
  }
}

export interface EvalJobsStackProps extends cdk.StackProps {
  judgeModelIds: string[];
}

/** Bucket and role in the Region where Bedrock evaluation jobs run. */
export class EvalJobsStack extends cdk.Stack {
  public readonly jobResources: EvalJobResources;

  constructor(scope: Construct, id: string, props: EvalJobsStackProps) {
    super(scope, id, props);
    this.jobResources = new EvalJobResources(this, "Jobs", { judgeModelIds: props.judgeModelIds });
  }
}
