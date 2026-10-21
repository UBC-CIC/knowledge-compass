import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { IConstruct } from "constructs";

// Lambda and CodeBuild logs can carry request detail; keep them for 90 days
// instead of the CloudWatch default of never expiring (security plan F08).
export const SERVICE_LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;

/**
 * Sets a retention policy on the default log group of every Lambda function
 * and CodeBuild project that does not configure its own. Uses LogRetention
 * (a custom resource) rather than a LogGroup resource: the /aws/lambda/<name>
 * and /aws/codebuild/<name> groups already exist in deployed accounts, so
 * declaring them as LogGroup resources would fail the deploy.
 */
export class ServiceLogRetention implements cdk.IAspect {
  constructor(private readonly retention: logs.RetentionDays = SERVICE_LOG_RETENTION) {}

  visit(node: IConstruct): void {
    if (node instanceof lambda.Function) {
      const cfn = node.node.defaultChild as lambda.CfnFunction;
      const loggingConfig = cfn.loggingConfig as lambda.CfnFunction.LoggingConfigProperty | undefined;
      if (node.node.tryFindChild("LogRetention") || loggingConfig?.logGroup) return;
      new logs.LogRetention(node, "LogRetention", {
        logGroupName: `/aws/lambda/${node.functionName}`,
        retention: this.retention,
      });
    } else if (node instanceof codebuild.Project) {
      const cfn = node.node.defaultChild as codebuild.CfnProject;
      const logsConfig = cfn.logsConfig as codebuild.CfnProject.LogsConfigProperty | undefined;
      if (node.node.tryFindChild("LogRetention") || logsConfig?.cloudWatchLogs) return;
      new logs.LogRetention(node, "LogRetention", {
        logGroupName: `/aws/codebuild/${node.projectName}`,
        retention: this.retention,
      });
    }
  }
}
