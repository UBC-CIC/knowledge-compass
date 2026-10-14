import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { EvalJobsStack, EvalStack, evalSigningSecretName } from "../lib/eval-stack";

const env = { account: "111111111111", region: "ca-central-1" };

function synth(includeJobResources = true): Template {
  const app = new cdk.App();
  const stack = new EvalStack(app, "KC-Eval", {
    env,
    stackPrefix: "KC",
    judgeModelIds: ["us.anthropic.claude-opus-4-6-v1"],
    includeJobResources,
  });
  return Template.fromStack(stack);
}

describe("EvalStack", () => {
  const template = synth();

  test("signing secret has the shared name and a generated value", () => {
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: evalSigningSecretName("KC"),
      GenerateSecretString: Match.objectLike({ GenerateStringKey: "signingKey", PasswordLength: 64 }),
    });
    const secrets = template.findResources("AWS::SecretsManager::Secret");
    for (const secret of Object.values(secrets)) {
      expect(secret.Properties.SecretString).toBeUndefined();
    }
  });

  test("results bucket is private, encrypted, SSL-only and expires objects", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: [Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } })],
      }),
      LoggingConfiguration: Match.objectLike({ LogFilePrefix: "results-access-logs/" }),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ Id: "ExpireEvalArtifacts", ExpirationInDays: 30, Status: "Enabled" })]),
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
  });

  test("evaluation role trusts Bedrock for this account only", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: "bedrock.amazonaws.com" },
            Condition: {
              StringEquals: { "aws:SourceAccount": env.account },
              ArnLike: { "aws:SourceArn": `arn:aws:bedrock:${env.region}:${env.account}:evaluation-job/*` },
            },
          }),
        ],
      },
    });
  });

  test("evaluation role may invoke only the judge model", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const invoke = statements.find((s) => s.Sid === "InvokeJudgeModels");
    expect(invoke.Resource).toEqual([
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-6-v1",
      `arn:aws:bedrock:${env.region}:${env.account}:inference-profile/us.anthropic.claude-opus-4-6-v1`,
    ]);
    for (const s of statements) {
      const actions = [s.Action].flat();
      expect(actions).not.toContain("*");
      expect(actions).not.toContain("s3:*");
      expect(actions).not.toContain("bedrock:*");
    }
  });

  test("job resources can live in a separate Region stack", () => {
    const withoutJobs = synth(false);
    withoutJobs.resourceCountIs("AWS::S3::Bucket", 0);
    withoutJobs.resourceCountIs("AWS::IAM::Role", 0);

    const app = new cdk.App();
    const jobs = new EvalJobsStack(app, "KC-EvalJobs", {
      env: { account: env.account, region: "us-west-2" },
      judgeModelIds: ["us.anthropic.claude-opus-4-6-v1"],
    });
    const jobsTemplate = Template.fromStack(jobs);
    jobsTemplate.resourceCountIs("AWS::SecretsManager::Secret", 0);
    jobsTemplate.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: Match.objectLike({
              ArnLike: { "aws:SourceArn": `arn:aws:bedrock:us-west-2:${env.account}:evaluation-job/*` },
            }),
          }),
        ],
      },
    });
  });
});
