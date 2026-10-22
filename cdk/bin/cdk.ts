#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { ApiGatewayStack } from "../lib/api-stack";
import { DBFlowStack } from "../lib/dbFlow-stack";
import { AmplifyStack } from "../lib/amplify-stack";
import { CICDStack } from "../lib/cicd-stack";
import { IngestionStack } from "../lib/ingestion-stack";
import { EvalJobsStack, EvalStack, evalSigningSecretName } from "../lib/eval-stack";
import { CostStack } from "../lib/cost-stack";
import { ServiceLogRetention } from "../lib/log-retention";

const app = new cdk.App();
// 90-day retention on every Lambda and CodeBuild log group (lib/log-retention.ts).
cdk.Aspects.of(app).add(new ServiceLogRetention());

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const StackPrefix = app.node.tryGetContext("StackPrefix");
const environment = app.node.tryGetContext("environment");
const version = app.node.tryGetContext("versionNumber");
const githubRepo = app.node.tryGetContext("githubRepo");
const githubBranch = app.node.tryGetContext("githubBranch") || "main";
// Optional `-c alarmEmail=<address>`: subscribes the address to the operational
// alarm topic. Without it the topic and alarm actions exist with no subscriber.
const alarmEmail: string | undefined = app.node.tryGetContext("alarmEmail") || undefined;
// Optional `-c monthlyBudgetUsd=<amount>`: monthly AWS Budget (50/80/100% alerts to
// the alarm topic). Without it the budget is skipped; cost anomaly alerts still deploy.
const monthlyBudgetUsdContext = app.node.tryGetContext("monthlyBudgetUsd");
const monthlyBudgetUsd: number | undefined =
  monthlyBudgetUsdContext === undefined || monthlyBudgetUsdContext === ""
    ? undefined
    : Number(monthlyBudgetUsdContext);
// Opt-in `-c enableReservedConcurrency=true`: reserves concurrency for the public
// Lambdas (see ApiGatewayStack). Default off: Lambda keeps at least 100 unreserved,
// so any reservation fails the deploy until the account concurrency quota is raised.
const enableReservedConcurrency = ["true", true].includes(
  app.node.tryGetContext("enableReservedConcurrency"),
);

// Evaluation harness (evals/): opt-in with `-c enableEval=true`.
//   evalJobRegion   Region for Bedrock evaluation jobs (default: stack Region)
//   evalJudgeModels comma-separated judge model / inference profile ids
const enableEval = ["true", true].includes(app.node.tryGetContext("enableEval"));
const evalJobRegion: string | undefined = app.node.tryGetContext("evalJobRegion") || env.region;
const evalJudgeModels: string[] = String(
  app.node.tryGetContext("evalJudgeModels") || "us.anthropic.claude-opus-4-6-v1",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const vpcStack = new VpcStack(app, `${StackPrefix}-VpcStack`, {
  env,
  stackPrefix: StackPrefix,
});

const dbStack = new DatabaseStack(app, `${StackPrefix}-Database`, vpcStack, {
  env,
});

const dbFlowStack = new DBFlowStack(
  app,
  `${StackPrefix}-DBFlow`,
  vpcStack,
  dbStack,
  { env },
);

const cicdStack = new CICDStack(app, `${StackPrefix}-CICD`, {
  env,
  githubRepo: githubRepo,
  githubBranch: githubBranch,
  environmentName: environment,
  lambdaFunctions: [
    // pgvector ingestion container images (R2). These are ECS task images, not
    // Lambdas, so functionName is unused by the ECS consumer; the CICD build step
    // that runs `lambda update-function-code` no-ops when the function is absent.
    // Build context is "cdk/containers" so the shared common/ package is present.
    {
      name: "crawler",
      functionName: `${StackPrefix}-Ingestion-Crawler`,
      sourceDir: "cdk/containers/crawler",
      // Build context is the containers root so the shared common/ package is included.
      buildContext: "cdk/containers",
      dockerfile: "cdk/containers/crawler/Dockerfile",
    },
    {
      name: "transcriber",
      functionName: `${StackPrefix}-Ingestion-Transcriber`,
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

const ingestionStack = new IngestionStack(
  app,
  `${StackPrefix}-Ingestion`,
  vpcStack,
  dbStack,
  {
    env,
    stackPrefix: StackPrefix,
    crawlerRepository: cicdStack.ecrRepositories["crawler"],
    transcriberRepository: cicdStack.ecrRepositories["transcriber"],
    imageBuildPipelineName: cicdStack.pipelineName,
  },
);
ingestionStack.addDependency(cicdStack);
ingestionStack.addDependency(vpcStack);
ingestionStack.addDependency(dbStack);

const apiStack = new ApiGatewayStack(
  app,
  `${StackPrefix}-Api`,
  dbStack,
  vpcStack,
  {
    env,
    ecrRepositories: cicdStack.ecrRepositories,
    // pgvector ingestion: sets INGESTION_BACKEND=pgvector + ECS env on
    // lambdaKnowledgeBase and grants ecs:RunTask / iam:PassRole.
    ingestion: {
      ingestionEnv: () => ingestionStack.ingestionEnv(),
      grantRunTasks: (principal) => ingestionStack.grantRunTasks(principal),
      grantBucketAccess: (principal) =>
        ingestionStack.ingestBucket.grantReadWrite(principal),
    },
    // Plain name (no EvalStack reference). Only wired with -c enableEval=true,
    // so without the EvalStack the API neither reads nor is granted a secret at
    // this predictable name (nobody can plant one to forge eval tags).
    evalSigningSecretName: enableEval ? evalSigningSecretName(StackPrefix || "KC") : undefined,
    alarmEmail: alarmEmail ? String(alarmEmail) : undefined,
    enableReservedConcurrency,
  },
);
apiStack.addDependency(cicdStack);
apiStack.addDependency(ingestionStack);
// The API and ingestion workers require the additive database migrations to
// be applied before their code is deployed. This also makes `cdk deploy --all`
// order DBFlow ahead of the API stack; production rollback remains roll-forward
// because CloudFormation does not run migration downs.
apiStack.addDependency(dbFlowStack);

const amplifyStack = new AmplifyStack(app, `${StackPrefix}-Amplify`, apiStack, {
  env,
  githubRepo: githubRepo,
  githubBranch: githubBranch,
  ingestBucketName: ingestionStack.ingestBucket.bucketName,
  allowedOriginsParamName: apiStack.allowedOriginsParamName,
});
amplifyStack.addDependency(apiStack);
amplifyStack.addDependency(ingestionStack);

// Imports the Api stack's alarm topic ARN (one-way: Cost depends on Api).
const costStack = new CostStack(app, `${StackPrefix}-Cost`, {
  env,
  alarmTopic: apiStack.opsAlarmTopic,
  monthlyBudgetUsd,
});
costStack.addDependency(apiStack);

const resolvedPrefix = StackPrefix || "KC";
const stackTags = {
  Project: resolvedPrefix,
  StackPrefix: resolvedPrefix,
  Environment: environment || "dev",
  ManagedBy: "CDK",
};

const stacks: cdk.Stack[] = [
  vpcStack,
  dbStack,
  dbFlowStack,
  cicdStack,
  ingestionStack,
  apiStack,
  amplifyStack,
  costStack,
];

if (enableEval) {
  const jobsInStackRegion = !evalJobRegion || evalJobRegion === env.region;
  const evalStack = new EvalStack(app, `${StackPrefix}-Eval`, {
    env,
    stackPrefix: StackPrefix || "KC",
    judgeModelIds: evalJudgeModels,
    includeJobResources: jobsInStackRegion,
  });
  stacks.push(evalStack);
  if (!jobsInStackRegion) {
    stacks.push(
      new EvalJobsStack(app, `${StackPrefix}-EvalJobs`, {
        env: { account: env.account, region: evalJobRegion },
        judgeModelIds: evalJudgeModels,
      }),
    );
  }
}

stacks.forEach((stack) => {
  Object.entries(stackTags).forEach(([key, value]) => {
    cdk.Tags.of(stack).add(key, value);
  });
});
