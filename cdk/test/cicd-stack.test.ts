import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CICDStack } from "../lib/cicd-stack";

function synth(): Template {
  const app = new cdk.App();
  const stack = new CICDStack(app, "KC-CICD", {
    env: { account: "111111111111", region: "ca-central-1" },
    githubRepo: "knowledge-compass",
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
    ],
  });
  return Template.fromStack(stack);
}

describe("CICDStack", () => {
  const template = synth();

  test("pipeline runs Source, then Test, then Build", () => {
    const pipelines = template.findResources("AWS::CodePipeline::Pipeline");
    const [pipeline] = Object.values(pipelines);
    const stages = (pipeline.Properties.Stages as { Name: string }[]).map((s) => s.Name);
    expect(stages).toEqual(["Source", "Test", "Build"]);
  });

  test("unit test project is unprivileged and runs every suite", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: "KC-CICD-UnitTests",
      Environment: Match.objectLike({ PrivilegedMode: false }),
    });

    const projects = template.findResources("AWS::CodeBuild::Project", {
      Properties: { Name: "KC-CICD-UnitTests" },
    });
    const buildSpec = String(Object.values(projects)[0].Properties.Source.BuildSpec);
    for (const step of [
      "npx jest --ci",
      "npm run test:lambda",
      "lambda/textGeneration && PYTHONDONTWRITEBYTECODE=1 python -m unittest",
      "lambda/knowledgeBase && PYTHONDONTWRITEBYTECODE=1 python -m unittest",
    ]) {
      expect(buildSpec).toContain(step);
    }
  });

  test("legacy vectorIndexManagerSigV4 resources are gone", () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/vectorIndexManager/i);
  });
});
