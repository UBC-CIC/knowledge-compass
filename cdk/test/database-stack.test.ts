import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";

const env = { account: "111111111111", region: "ca-central-1" };

const app = new cdk.App();
const vpcStack = new VpcStack(app, "KC-VpcStack", { env, stackPrefix: "KC" });
const dbStack = new DatabaseStack(app, "KC-Database", vpcStack, { env });
const resources: Record<string, any> = Template.fromStack(dbStack).toJSON().Resources;

const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

const rdsConnectStatements = (): any[] =>
  Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy")
    .flatMap((r) => r.Properties.PolicyDocument.Statement)
    .filter((s: any) => asArray(s.Action).includes("rds-db:connect"));

describe("DatabaseStack IAM", () => {
  test("rds-db:connect is never granted on a wildcard resource", () => {
    const statements = rdsConnectStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      for (const r of asArray(s.Resource)) {
        expect(r).not.toEqual("*");
      }
    }
  });
});
