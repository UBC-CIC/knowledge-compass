/**
 * Finding f-9bda4252: WAF rate buckets must not be chosen from the
 * Authorization header. WAF runs before the API Gateway authorizer, so
 * `Authorization: Bearer x` is attacker-controlled.
 */
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { wafIpRateLimitRules } from "../lib/api-stack";

type Json = Record<string, unknown>;

function rateOf(rule: wafv2.CfnWebACL.RuleProperty | undefined): Json {
  const statement = rule?.statement as wafv2.CfnWebACL.StatementProperty | undefined;
  return statement?.rateBasedStatement as unknown as Json;
}

function nodes(value: unknown, found: Json[] = []): Json[] {
  if (Array.isArray(value)) {
    for (const item of value) nodes(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    const record = value as Json;
    found.push(record);
    for (const child of Object.values(record)) nodes(child, found);
  }
  return found;
}

describe("WAF IP rate limits", () => {
  const rules = wafIpRateLimitRules();
  const byName = new Map(rules.map((rule) => [rule.name, rule]));

  test("no rate rule inspects Authorization or the Bearer substring", () => {
    for (const node of nodes(rules)) {
      const field = node.fieldToMatch;
      if (field && typeof field === "object") {
        expect((field as Json).singleHeader).toBeUndefined();
      }
      expect(node.searchString).not.toBe("Bearer");
    }
  });

  test("the 100-request bucket is the public-token path", () => {
    const rule = byName.get("LimitUnauthenticatedRequests");
    expect(rule?.priority).toBe(3);
    expect(rule?.action).toEqual({ block: {} });
    expect(rateOf(rule)).toEqual({
      limit: 100,
      aggregateKeyType: "IP",
      evaluationWindowSec: 300,
      scopeDownStatement: {
        byteMatchStatement: {
          searchString: "/user/publicToken",
          fieldToMatch: { uriPath: {} },
          textTransformations: [{ priority: 0, type: "URL_DECODE" }],
          positionalConstraint: "ENDS_WITH",
        },
      },
    });
  });

  test("the 2000-request bucket is a global per-IP ceiling", () => {
    const rule = byName.get("LimitAuthenticatedRequests");
    expect(rule?.priority).toBe(4);
    expect(rule?.action).toEqual({ block: {} });
    const statement = rateOf(rule);
    expect(statement.limit).toBe(2000);
    expect(statement.aggregateKeyType).toBe("IP");
    expect(statement.evaluationWindowSec).toBe(300);
    expect(statement.scopeDownStatement).toBeUndefined();
  });

  test("chat generation and identity minting stay on the URI path", () => {
    expect(rateOf(byName.get("LimitExpensiveEndpoints"))).toMatchObject({
      limit: 1000,
      aggregateKeyType: "IP",
      scopeDownStatement: {
        byteMatchStatement: {
          searchString: "/chat_sessions",
          fieldToMatch: { uriPath: {} },
          positionalConstraint: "CONTAINS",
        },
      },
    });

    const mint = rateOf(byName.get("LimitIdentityMinting"));
    expect(mint.limit).toBe(60);
    const scope = JSON.stringify(mint.scopeDownStatement);
    expect(scope).toContain("/user/publicToken/?$");
    expect(scope).toContain("/user/?$");
    expect(scope).toContain("POST");
    expect(scope).not.toContain("authorization");
  });

  test("every rate rule blocks and priorities do not collide", () => {
    expect(rules.map((rule) => rule.priority)).toEqual([3, 4, 5, 6]);
    for (const rule of rules) expect(rule.action).toEqual({ block: {} });
  });
});
