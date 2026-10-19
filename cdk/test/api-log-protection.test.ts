// Regression test for security finding f-a9c7f3e7: API Gateway must not log request or
// response bodies or WebSocket frames, and the API/WAF log groups are CMK-encrypted,
// retained for a year and kept on stack deletion. Synthesizes the stacks the way
// bin/cdk.ts does and asserts the logging shape of the KC-Api template.
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { CICDStack } from "../lib/cicd-stack";
import { IngestionStack } from "../lib/ingestion-stack";
import { ApiGatewayStack } from "../lib/api-stack";

// Lambda assets and the OpenAPI definition are cwd-relative (cdk/).
process.chdir(path.resolve(__dirname, ".."));
jest.setTimeout(600_000);

type Resources = Record<string, any>;

const env = { account: "111111111111", region: "ca-central-1" };
let resources: Resources;

beforeAll(() => {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, "KC-VpcStack", { env, stackPrefix: "KC" });
  const dbStack = new DatabaseStack(app, "KC-Database", vpcStack, { env });
  const cicdStack = new CICDStack(app, "KC-CICD", {
    env,
    githubRepo: "owner/repo",
    githubBranch: "main",
    environmentName: "dev",
    lambdaFunctions: [
      {
        name: "crawler",
        functionName: "KC-Ingestion-Crawler",
        sourceDir: "cdk/containers/crawler",
        buildContext: "cdk/containers",
        dockerfile: "cdk/containers/crawler/Dockerfile",
      },
      {
        name: "transcriber",
        functionName: "KC-Ingestion-Transcriber",
        sourceDir: "cdk/containers/transcriber",
        buildContext: "cdk/containers",
        dockerfile: "cdk/containers/transcriber/Dockerfile",
      },
    ],
    pathFilters: [
      "cdk/containers/crawler/**",
      "cdk/containers/transcriber/**",
      "cdk/containers/common/**",
    ],
  });
  const ingestionStack = new IngestionStack(app, "KC-Ingestion", vpcStack, dbStack, {
    env,
    stackPrefix: "KC",
    crawlerRepository: cicdStack.ecrRepositories["crawler"],
    transcriberRepository: cicdStack.ecrRepositories["transcriber"],
    imageBuildPipelineName: cicdStack.pipelineName,
  });
  const apiStack = new ApiGatewayStack(app, "KC-Api", dbStack, vpcStack, {
    env,
    ecrRepositories: cicdStack.ecrRepositories,
    ingestion: {
      ingestionEnv: () => ingestionStack.ingestionEnv(),
      grantRunTasks: (principal) => ingestionStack.grantRunTasks(principal),
      grantBucketAccess: (principal) => ingestionStack.ingestBucket.grantReadWrite(principal),
    },
    evalSigningSecretName: undefined,
    enableReservedConcurrency: false,
  });
  resources = Template.fromStack(apiStack).toJSON().Resources;
});

const ofType = (type: string): [string, any][] =>
  Object.entries(resources).filter(([, r]) => r.Type === type);

const FORBIDDEN_FORMAT = [/\$context\.message/i, /querystring/i, /authorization/i];

test("REST stage disables data trace and logs errors only", () => {
  const stages = ofType("AWS::ApiGateway::Stage");
  expect(stages).toHaveLength(1);
  const settings: any[] = stages[0][1].Properties.MethodSettings;
  const all = settings.find((s) => s.ResourcePath === "/*" && s.HttpMethod === "*");
  expect(all).toMatchObject({ DataTraceEnabled: false, LoggingLevel: "ERROR" });
  for (const s of settings) {
    if ("DataTraceEnabled" in s) expect(s.DataTraceEnabled).toBe(false);
    if ("LoggingLevel" in s) expect(s.LoggingLevel).toBe("ERROR");
  }
  const format: string = stages[0][1].Properties.AccessLogSetting.Format;
  for (const pattern of FORBIDDEN_FORMAT) expect(format).not.toMatch(pattern);
});

test("WebSocket stage never logs client frames", () => {
  const stages = ofType("AWS::ApiGatewayV2::Stage");
  expect(stages).toHaveLength(1);
  const props = stages[0][1].Properties;
  expect(props.DefaultRouteSettings.DataTraceEnabled).toBe(false);
  const format = JSON.parse(props.AccessLogSettings.Format);
  expect(format).not.toHaveProperty("message");
  for (const value of Object.values(format)) {
    for (const pattern of FORBIDDEN_FORMAT) expect(String(value)).not.toMatch(pattern);
  }
});

test("API and WAF log groups use the CMK, a year of retention and Retain", () => {
  const groups = ofType("AWS::Logs::LogGroup").filter(([id]) =>
    ["KCApiApiAccessLogs", "KCApiWebSocketAccessLogs", "KCApiWafLogs"].some((prefix) => id.startsWith(prefix))
  );
  expect(groups).toHaveLength(3);
  const [[keyId]] = ofType("AWS::KMS::Key");
  for (const [, group] of groups) {
    expect(group.Properties.KmsKeyId).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
    expect(group.Properties.RetentionInDays).toBe(365);
    expect(group.DeletionPolicy).toBe("Retain");
    expect(group.UpdateReplacePolicy).toBe("Retain");
    expect(group.Properties.DataProtectionPolicy).toBeDefined();
  }
});

test("log CMK rotates, is retained and lets CloudWatch Logs use it in this account/region", () => {
  const keys = ofType("AWS::KMS::Key");
  expect(keys).toHaveLength(1);
  const [, key] = keys[0];
  expect(key.Properties.EnableKeyRotation).toBe(true);
  expect(key.DeletionPolicy).toBe("Retain");
  const logsStatement = key.Properties.KeyPolicy.Statement.find(
    (s: any) => s.Principal?.Service === "logs.ca-central-1.amazonaws.com"
  );
  expect(logsStatement).toBeDefined();
  // The partition stays a pseudo-parameter (Fn::Join), so match the rest of the ARN.
  const condition = JSON.stringify(logsStatement.Condition.ArnLike["kms:EncryptionContext:aws:logs:arn"]);
  expect(condition).toContain(":logs:ca-central-1:111111111111:log-group:*");
});
