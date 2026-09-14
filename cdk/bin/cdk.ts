#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { ApiGatewayStack } from "../lib/api-stack";
import { DBFlowStack } from "../lib/dbFlow-stack";
import { AmplifyStack } from "../lib/amplify-stack";
import { CICDStack } from "../lib/cicd-stack";
import { KnowledgeBaseStack } from "../lib/knowledge-base-stack";
import { IngestionStack } from "../lib/ingestion-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const StackPrefix = app.node.tryGetContext("StackPrefix");
const environment = app.node.tryGetContext("environment");
const version = app.node.tryGetContext("versionNumber");
const githubRepo = app.node.tryGetContext("githubRepo");
const githubBranch = app.node.tryGetContext("githubBranch") || "main";

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
  { env }
);

const cicdStack = new CICDStack(app, `${StackPrefix}-CICD`, {
  env,
  githubRepo: githubRepo,
  githubBranch: githubBranch,
  environmentName: environment,
  lambdaFunctions: [
    {
      name: "vectorIndexManagerSigV4",
      functionName: `${StackPrefix}-KnowledgeBase-VectorIndexManagerFn-v2`,
      sourceDir: "cdk/lambda/vectorIndexManagerSigV4",
    },
    // pgvector ingestion container images (R2). These are ECS task images, not
    // Lambdas, so functionName is unused by the ECS consumer; the CICD build step
    // that runs `lambda update-function-code` no-ops when the function is absent.
    // Build context is "Project Refactoring" so the shared common/ package is present.
    {
      name: "crawler",
      functionName: `${StackPrefix}-Ingestion-Crawler`,
      sourceDir: "Project Refactoring/crawler",
    },
    {
      name: "transcriber",
      functionName: `${StackPrefix}-Ingestion-Transcriber`,
      sourceDir: "Project Refactoring/transcriber",
    },
  ],
  pathFilters: [
    "cdk/lambda/vectorIndexManagerSigV4/**",
    "Project Refactoring/crawler/**",
    "Project Refactoring/transcriber/**",
    "Project Refactoring/common/**",
  ],
});

const kbStack = new KnowledgeBaseStack(app, `${StackPrefix}-KnowledgeBase`, {
  env,
  stackPrefix: StackPrefix,
  vectorIndexManagerRepository: cicdStack.ecrRepositories["vectorIndexManagerSigV4"],
  vectorIndexManagerPipelineName: cicdStack.pipelineName,
  vpc: vpcStack.vpc,
  vpcCidr: vpcStack.vpcCidrString,
});
kbStack.addDependency(cicdStack);
kbStack.addDependency(vpcStack);

// pgvector ingestion infrastructure (R2). SYNTH-PENDING: see ingestion-stack.ts.
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
  }
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
    knowledgeBaseBucket: kbStack.knowledgeBaseBucket,
    knowledgeBaseSecret: kbStack.knowledgeBaseSecret,
  }
);
apiStack.addDependency(kbStack);
apiStack.addDependency(cicdStack);

// SYNTH-PENDING integration (R2): to activate the pgvector ingestion path, the
// ApiGatewayStack must accept the IngestionStack and, on lambdaKnowledgeBase:
//   1. add env: ingestionStack.ingestionEnv()  (sets INGESTION_BACKEND=pgvector +
//      ECS_CLUSTER_ARN / TASK_DEF_ARNs / SUBNET_IDS / SECURITY_GROUP_IDS / container names)
//   2. grant run access: ingestionStack.grantRunTasks(lambdaKnowledgeBase)
// This is intentionally NOT wired here to avoid coupling api-stack to the
// ingestion stack before a dev-stack `cdk synth` review. Also note: the CICD
// buildspec builds with context = sourceDir, but the crawler/transcriber
// Dockerfiles expect context = "Project Refactoring/" (for the shared common/
// package) — the buildspec (cicd-stack.ts) must be adjusted for these two images.

const amplifyStack = new AmplifyStack(app, `${StackPrefix}-Amplify`, apiStack, {
  env,
  githubRepo: githubRepo,
  githubBranch: githubBranch,
  knowledgeBaseBucketName: kbStack.knowledgeBaseBucket.bucketName,
  allowedOriginsParamName: apiStack.allowedOriginsParamName,
});
amplifyStack.addDependency(apiStack);

const resolvedPrefix = StackPrefix || "KC";
const stackTags = {
  Project: resolvedPrefix,
  StackPrefix: resolvedPrefix,
  Environment: environment || "dev",
  ManagedBy: "CDK",
};

const stacks = [
  vpcStack,
  dbStack,
  dbFlowStack,
  cicdStack,
  kbStack,
  ingestionStack,
  apiStack,
  amplifyStack,
];

stacks.forEach((stack) => {
  Object.entries(stackTags).forEach(([key, value]) => {
    cdk.Tags.of(stack).add(key, value);
  });
});
