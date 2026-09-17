#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { ApiGatewayStack } from "../lib/api-stack";
import { DBFlowStack } from "../lib/dbFlow-stack";
import { AmplifyStack } from "../lib/amplify-stack";
import { CICDStack } from "../lib/cicd-stack";
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
    // Kept until KC-KnowledgeBase is deleted; the leftover stack still imports
    // this ECR repo export. Remove after the old KB stack is gone.
    {
      name: "vectorIndexManagerSigV4",
      functionName: `${StackPrefix}-KnowledgeBase-VectorIndexManagerFn-v2`,
      sourceDir: "cdk/lambda/vectorIndexManagerSigV4",
    },
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
    "cdk/lambda/vectorIndexManagerSigV4/**",
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
    vectorIndexManagerRepository: cicdStack.ecrRepositories["vectorIndexManagerSigV4"],
    imageBuildPipelineName: cicdStack.pipelineName,
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
    // pgvector ingestion: sets INGESTION_BACKEND=pgvector + ECS env on
    // lambdaKnowledgeBase and grants ecs:RunTask / iam:PassRole.
    ingestion: {
      ingestionEnv: () => ingestionStack.ingestionEnv(),
      grantRunTasks: (principal) => ingestionStack.grantRunTasks(principal),
      grantBucketAccess: (principal) =>
        ingestionStack.ingestBucket.grantReadWrite(principal),
    },
  }
);
apiStack.addDependency(cicdStack);
apiStack.addDependency(ingestionStack);

const amplifyStack = new AmplifyStack(app, `${StackPrefix}-Amplify`, apiStack, {
  env,
  githubRepo: githubRepo,
  githubBranch: githubBranch,
  ingestBucketName: ingestionStack.ingestBucket.bucketName,
  allowedOriginsParamName: apiStack.allowedOriginsParamName,
});
amplifyStack.addDependency(apiStack);
amplifyStack.addDependency(ingestionStack);

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
  ingestionStack,
  apiStack,
  amplifyStack,
];

stacks.forEach((stack) => {
  Object.entries(stackTags).forEach(([key, value]) => {
    cdk.Tags.of(stack).add(key, value);
  });
});
