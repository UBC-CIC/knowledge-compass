import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import * as sns from "aws-cdk-lib/aws-sns";
import { CostStack } from "../lib/cost-stack";

const env = { account: "111111111111", region: "ca-central-1" };

function synth(monthlyBudgetUsd?: number): { stack: CostStack; template: Template } {
  const app = new cdk.App();
  // Stands in for ApiGatewayStack, which owns the alarm topic.
  const topicStack = new cdk.Stack(app, "KC-Api", { env });
  const topic = new sns.Topic(topicStack, "OpsAlarmTopic");
  const stack = new CostStack(app, "KC-Cost", { env, alarmTopic: topic, monthlyBudgetUsd });
  return { stack, template: Template.fromStack(stack) };
}

const importedTopicArn = { "Fn::ImportValue": Match.stringLikeRegexp("OpsAlarmTopic") };

describe("CostStack", () => {
  test("monthly COST budget notifies the alarm topic at 50/80/100%", () => {
    const { template } = synth(250);
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetName: "KC-Cost-Monthly",
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 250, Unit: "USD" },
      },
      NotificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
        Notification: {
          NotificationType: "ACTUAL",
          ComparisonOperator: "GREATER_THAN",
          Threshold: threshold,
          ThresholdType: "PERCENTAGE",
        },
        Subscribers: [{ SubscriptionType: "SNS", Address: importedTopicArn }],
      })),
    });
  });

  test("without monthlyBudgetUsd the budget is skipped with an info note", () => {
    const { stack, template } = synth();
    template.resourceCountIs("AWS::Budgets::Budget", 0);
    Annotations.fromStack(stack).hasInfo("*", Match.stringLikeRegexp("monthlyBudgetUsd"));
    // Anomaly detection does not depend on the budget amount.
    template.resourceCountIs("AWS::CE::AnomalyMonitor", 1);
    template.resourceCountIs("AWS::CE::AnomalySubscription", 1);
  });

  test("rejects a non-positive or non-numeric budget", () => {
    expect(() => synth(0)).toThrow(/monthlyBudgetUsd/);
    expect(() => synth(Number("abc"))).toThrow(/monthlyBudgetUsd/);
  });

  test("SERVICE anomaly monitor sends IMMEDIATE alerts to the alarm topic", () => {
    const { template } = synth();
    template.hasResourceProperties("AWS::CE::AnomalyMonitor", {
      MonitorType: "DIMENSIONAL",
      MonitorDimension: "SERVICE",
    });
    template.hasResourceProperties("AWS::CE::AnomalySubscription", {
      Frequency: "IMMEDIATE",
      MonitorArnList: [{ "Fn::GetAtt": [Match.stringLikeRegexp("ServiceAnomalyMonitor"), "MonitorArn"] }],
      Subscribers: [{ Type: "SNS", Address: importedTopicArn }],
      ThresholdExpression: Match.serializedJson({
        Dimensions: {
          Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
          MatchOptions: ["GREATER_THAN_OR_EQUAL"],
          Values: ["10"],
        },
      }),
    });
  });

  test("cost stack does not create or own the topic or its policy", () => {
    const { template } = synth(100);
    template.resourceCountIs("AWS::SNS::Topic", 0);
    template.resourceCountIs("AWS::SNS::TopicPolicy", 0);
  });
});
