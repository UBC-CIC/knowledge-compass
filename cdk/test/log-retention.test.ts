// Security plan F08: Lambda and CodeBuild log groups get a 90-day retention
// policy (ServiceLogRetention aspect, applied app-wide in bin/cdk.ts) unless the
// resource configures its own log group.
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { ServiceLogRetention } from "../lib/log-retention";

function synth() {
  const app = new cdk.App();
  cdk.Aspects.of(app).add(new ServiceLogRetention());
  const stack = new cdk.Stack(app, "LogRetentionTest");
  const code = lambda.Code.fromInline("exports.handler = async () => {};");
  new lambda.Function(stack, "Plain", {
    functionName: "kc-plain",
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code,
  });
  new lambda.Function(stack, "OwnGroup", {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code,
    logGroup: new logs.LogGroup(stack, "OwnGroupLogs", { retention: logs.RetentionDays.ONE_WEEK }),
  });
  new codebuild.Project(stack, "Build", {
    projectName: "kc-build",
    buildSpec: codebuild.BuildSpec.fromObject({ version: "0.2", phases: {} }),
  });
  return Template.fromStack(stack);
}

test("default Lambda and CodeBuild log groups get 90-day retention", () => {
  const template = synth();
  const retentions = Object.values(template.findResources("Custom::LogRetention")).map(
    (r: any) => r.Properties,
  );
  expect(retentions).toHaveLength(2);
  expect(retentions.every((p) => p.RetentionInDays === 90)).toBe(true);
  const names = JSON.stringify(retentions.map((p) => p.LogGroupName));
  expect(names).toContain("/aws/lambda/");
  expect(names).toContain("/aws/codebuild/");
});

test("a function with its own log group is left alone", () => {
  const template = synth();
  template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 7 });
  const names = JSON.stringify(
    Object.values(template.findResources("Custom::LogRetention")).map((r: any) => r.Properties.LogGroupName),
  );
  expect(names).not.toContain("OwnGroup");
});
