import * as cdk from "aws-cdk-lib";
import { Annotations } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

/**
 * Account-level cost alerts (F05). Both alert types publish to the operational
 * alarm topic owned by ApiGatewayStack, whose topic policy allows
 * budgets.amazonaws.com and costalerts.amazonaws.com for this account. This
 * stack only imports the topic ARN, so it depends on the Api stack and never
 * the other way round (no cycle).
 *
 *   - Monthly COST budget with 50/80/100% actual-spend notifications. Created
 *     only when `monthlyBudgetUsd` is set (D4 is undecided); otherwise synth
 *     records an info annotation and skips it.
 *   - Cost Anomaly Detection: one AWS services (SERVICE dimension) monitor and
 *     an IMMEDIATE SNS subscription. CloudFormation supports these resources in
 *     every commercial Region (since Dec 2023), so no us-east-1 stack is needed.
 *
 * Budgets and anomaly monitors cover the whole account, not only this app.
 */

/** Notification thresholds, percent of the monthly budget (actual spend). */
export const BUDGET_THRESHOLDS_PERCENT = [50, 80, 100];

/** Minimum total anomaly impact (USD) that triggers an alert. Starting value pending D4. */
export const ANOMALY_IMPACT_THRESHOLD_USD = 10;

export interface CostStackProps extends cdk.StackProps {
  /** Topic that receives budget and anomaly notifications. */
  alarmTopic: sns.ITopic;
  /** Monthly budget in USD (context `monthlyBudgetUsd`). Omit to skip the budget. */
  monthlyBudgetUsd?: number;
}

export class CostStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CostStackProps) {
    super(scope, id, props);

    const topicArn = props.alarmTopic.topicArn;

    if (props.monthlyBudgetUsd === undefined) {
      Annotations.of(this).addInfo(
        "No monthly AWS Budget created: set `-c monthlyBudgetUsd=<amount>` to add one " +
          `(${BUDGET_THRESHOLDS_PERCENT.join("/")}% alerts to the ops alarm topic).`,
      );
    } else {
      const amount = props.monthlyBudgetUsd;
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`monthlyBudgetUsd must be a positive number, got "${amount}"`);
      }
      new budgets.CfnBudget(this, "MonthlyCostBudget", {
        budget: {
          budgetName: `${id}-Monthly`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount, unit: "USD" },
        },
        notificationsWithSubscribers: BUDGET_THRESHOLDS_PERCENT.map((threshold) => ({
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "SNS", address: topicArn }],
        })),
      });
    }

    // An account allows only one SERVICE-dimension monitor; see the commit notes
    // if the account already has one (for example Default-Services-Monitor).
    const monitor = new ce.CfnAnomalyMonitor(this, "ServiceAnomalyMonitor", {
      monitorName: `${id}-Services`,
      monitorType: "DIMENSIONAL",
      monitorDimension: "SERVICE",
    });

    // SNS subscribers require IMMEDIATE frequency.
    new ce.CfnAnomalySubscription(this, "AnomalyAlerts", {
      subscriptionName: `${id}-AnomalyAlerts`,
      frequency: "IMMEDIATE",
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [{ type: "SNS", address: topicArn }],
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
          MatchOptions: ["GREATER_THAN_OR_EQUAL"],
          Values: [String(ANOMALY_IMPACT_THRESHOLD_USD)],
        },
      }),
    });
  }
}
