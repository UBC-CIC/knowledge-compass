// Regression test for security finding f-4597100e: the API Lambdas no longer share one
// execution role with Cognito admin-group management. Synthesizes the stacks the way
// bin/cdk.ts does and asserts the IAM shape of the KC-Api template.
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { CICDStack } from "../lib/cicd-stack";
import { IngestionStack } from "../lib/ingestion-stack";
import { ApiGatewayStack } from "../lib/api-stack";

// Lambda assets and the OpenAPI definition are cwd-relative (cdk/).
process.chdir(path.resolve(__dirname, ".."));
jest.setTimeout(600_000);

type Resources = Record<string, any>;

// Concrete env: the Cognito trigger role name includes the Region.
const env = { account: "111111111111", region: "ca-central-1" };

let resources: Resources;

const SPLIT_FUNCTIONS = [
  "adminLambdaAuthorizer",
  "userLambdaAuthorizer",
  "userFunction",
  "lambdaTextGen",
  "lambdaKnowledgeBase",
  "chatSessionFunction",
];
const SHARED_FUNCTIONS = ["systemMessagesFunction", "adminFunction"];
const WEBSOCKET_FUNCTION_NAMES = ["KC-Api-ConnectFunction", "KC-Api-DisconnectFunction", "KC-Api-DefaultFunction"];
const COGNITO_TRIGGER_NAMES = ["KC-Api-addMemberOnSignUp", "KC-Api-preSignupLambda"];

beforeAll(() => {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, "KC-VpcStack", { env, stackPrefix: "KC" });
  const dbStack = new DatabaseStack(app, "KC-Database", vpcStack, { env });
  const cicdStack = new CICDStack(app, "KC-CICD", {
    env,
    githubRepo: "owner/repo",
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
      {
        name: "transcriber",
        functionName: "KC-Ingestion-Transcriber",
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
  const ingestionStack = new IngestionStack(app, "KC-Ingestion", vpcStack, dbStack, {
    env,
    stackPrefix: "KC",
    crawlerRepository: cicdStack.ecrRepositories["crawler"],
    transcriberRepository: cicdStack.ecrRepositories["transcriber"],
    imageBuildPipelineName: cicdStack.pipelineName,
  });
  const apiStack = new ApiGatewayStack(app, "KC-Api", dbStack, vpcStack, {
    env,
    ecrRepositories: cicdStack.ecrRepositories,
    ingestion: {
      ingestionEnv: () => ingestionStack.ingestionEnv(),
      grantRunTasks: (principal) => ingestionStack.grantRunTasks(principal),
      grantBucketAccess: (principal) => ingestionStack.ingestBucket.grantReadWrite(principal),
    },
    evalSigningSecretName: undefined,
    enableReservedConcurrency: false,
  });
  resources = Template.fromStack(apiStack).toJSON().Resources;
});

const roleOf = (fnId: string): string => resources[fnId].Properties.Role["Fn::GetAtt"][0];

const fnIdByName = (name: string): string => {
  const hit = Object.entries(resources).find(
    ([, r]) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === name
  );
  if (!hit) throw new Error(`function ${name} not found`);
  return hit[0];
};

const allRoleIds = (): string[] =>
  Object.entries(resources)
    .filter(([, r]) => r.Type === "AWS::IAM::Role")
    .map(([id]) => id);

const statementsFor = (roleId: string): any[] =>
  Object.values(resources)
    .filter((p) => p.Type === "AWS::IAM::Policy" && (p.Properties.Roles || []).some((x: any) => x.Ref === roleId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);

const allowActionsFor = (roleId: string): string[] =>
  statementsFor(roleId)
    .filter((s) => s.Effect === "Allow")
    .flatMap((s) => [s.Action].flat());

const cognitoTriggerRole = () => {
  const roles = new Set(COGNITO_TRIGGER_NAMES.map((n) => roleOf(fnIdByName(n))));
  expect(roles.size).toBe(1);
  return [...roles][0];
};

describe("API Lambda IAM least privilege", () => {
  test("no role other than the Cognito trigger role holds a cognito-idp action", () => {
    const trigger = cognitoTriggerRole();
    for (const roleId of allRoleIds()) {
      if (roleId === trigger) continue;
      expect(allowActionsFor(roleId).filter((a) => a.startsWith("cognito-idp:"))).toEqual([]);
    }
  });

  test("Cognito triggers use the readwrite DB credential, never the tablecreator one", () => {
    const secretStatements = statementsFor(cognitoTriggerRole()).filter((s) =>
      [s.Action].flat().some((a: string) => a.startsWith("secretsmanager:"))
    );
    expect(secretStatements.length).toBeGreaterThan(0);
    expect(JSON.stringify(secretStatements)).not.toMatch(/TableCreator/i);

    const envOf = (name: string) => resources[fnIdByName(name)].Properties.Environment.Variables;
    expect(envOf("KC-Api-addMemberOnSignUp").SM_DB_CREDENTIALS).toEqual(envOf("KC-Api-adminFunction").SM_DB_CREDENTIALS);
    expect(JSON.stringify(envOf("KC-Api-addMemberOnSignUp"))).not.toMatch(/TableCreator/i);
  });

  test("no statement grants iam:AddUserToGroup", () => {
    expect(JSON.stringify(resources)).not.toContain("iam:AddUserToGroup");
  });

  test("Cognito trigger role may only list groups, on this user pool", () => {
    const poolId = Object.entries(resources).find(([, r]) => r.Type === "AWS::Cognito::UserPool")![0];
    const cognitoStatements = statementsFor(cognitoTriggerRole()).filter((s) =>
      [s.Action].flat().some((a: string) => a.startsWith("cognito-idp:"))
    );
    expect(cognitoStatements).toHaveLength(1);
    expect([cognitoStatements[0].Action].flat()).toEqual(["cognito-idp:AdminListGroupsForUser"]);
    expect(cognitoStatements[0].Resource).toEqual({ "Fn::GetAtt": [poolId, "Arn"] });
  });

  test("authorizers, userFunction, text generation, knowledge base and chat sessions have their own roles", () => {
    const shared = new Set(SHARED_FUNCTIONS.map(roleOf));
    expect(shared.size).toBe(1);
    const sharedRole = [...shared][0];
    const splitRoles = SPLIT_FUNCTIONS.map(roleOf);
    expect(new Set(splitRoles).size).toBe(SPLIT_FUNCTIONS.length);
    expect(splitRoles).not.toContain(sharedRole);
    const onShared = Object.entries(resources)
      .filter(([, r]) => r.Type === "AWS::Lambda::Function" && r.Properties.Role["Fn::GetAtt"]?.[0] === sharedRole)
      .map(([id]) => id)
      .sort();
    expect(onShared).toEqual([...SHARED_FUNCTIONS].sort());
  });

  test("authorizer, public-token and chat session roles hold only secret/SSM/X-Ray reads", () => {
    const allowed = new Set([
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
    ]);
    const managed: Record<string, string> = {
      adminLambdaAuthorizer: "AWSLambdaVPCAccessExecutionRole",
      userLambdaAuthorizer: "AWSLambdaBasicExecutionRole",
      userFunction: "AWSLambdaVPCAccessExecutionRole",
      // Also where the eval signing-secret read lands when enableEval is on (f-7277748f).
      chatSessionFunction: "AWSLambdaVPCAccessExecutionRole",
    };
    for (const [fnId, policyName] of Object.entries(managed)) {
      const roleId = roleOf(fnId);
      for (const action of allowActionsFor(roleId)) expect(allowed).toContain(action);
      const arns = JSON.stringify(resources[roleId].Properties.ManagedPolicyArns);
      expect(arns).toContain(policyName);
    }
  });

  test("ingestion and Bedrock actions are confined to the roles that use them", () => {
    const kbRole = roleOf("lambdaKnowledgeBase");
    const textGenRole = roleOf("lambdaTextGen");
    for (const roleId of allRoleIds()) {
      const actions = allowActionsFor(roleId);
      if (roleId !== kbRole) {
        for (const prefix of ["textract:", "ecs:", "iam:", "s3:", "transcribe:"]) {
          expect(actions.filter((a) => a.startsWith(prefix))).toEqual([]);
        }
        if (roleId !== textGenRole) {
          // lifecycleCheckRole holds bedrock:ListFoundationModels (control plane, own role).
          expect(actions.filter((a) => a.startsWith("bedrock:") && a !== "bedrock:ListFoundationModels")).toEqual([]);
        }
      }
    }
    expect(allowActionsFor(kbRole)).toEqual(expect.arrayContaining([
      "bedrock:InvokeModel",
      "bedrock:Converse",
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles",
    ]));
  });

  test("request-handling roles carry the boundary; the Cognito trigger role does not", () => {
    const boundaries = Object.entries(resources).filter(
      ([, r]) =>
        r.Type === "AWS::IAM::ManagedPolicy" && r.Properties.ManagedPolicyName === "KC-Api-RequestHandlerBoundary"
    );
    expect(boundaries).toHaveLength(1);
    const [boundaryId, boundary] = boundaries[0];
    const fnIds = [...SPLIT_FUNCTIONS, ...SHARED_FUNCTIONS, ...WEBSOCKET_FUNCTION_NAMES.map(fnIdByName)];
    for (const fnId of fnIds) {
      expect(resources[roleOf(fnId)].Properties.PermissionsBoundary).toEqual({ Ref: boundaryId });
    }
    expect(resources[cognitoTriggerRole()].Properties.PermissionsBoundary).toBeUndefined();

    const stmts: any[] = boundary.Properties.PolicyDocument.Statement;
    const allowAll = stmts.find((s) => s.Effect === "Allow" && s.NotAction);
    expect([allowAll.NotAction].flat()).toEqual(expect.arrayContaining(["iam:*", "cognito-idp:Admin*"]));
    const passRole = stmts.find((s) => s.Effect === "Allow" && s.Action === "iam:PassRole");
    expect(passRole.Condition.StringEquals["iam:PassedToService"]).toEqual([
      "ecs-tasks.amazonaws.com",
      "transcribe.amazonaws.com",
    ]);
    const deny = stmts.find((s) => s.Effect === "Deny");
    expect([deny.Action].flat()).toEqual(["cognito-idp:Admin*"]);
  });

  // --- Finding f-7f03f151: authenticated self-invokes and admin MFA ---------

  const policyStatements = (): { roles: string[]; statement: any }[] =>
    Object.values(resources)
      .filter((p) => p.Type === "AWS::IAM::Policy")
      .flatMap((p) =>
        p.Properties.PolicyDocument.Statement.map((statement: any) => ({
          roles: (p.Properties.Roles || []).map((x: any) => x.Ref),
          statement,
        }))
      );

  const workerInvokeSecretId = (): string => {
    const hits = Object.entries(resources).filter(
      ([, r]) =>
        r.Type === "AWS::SecretsManager::Secret" && r.Properties.GenerateSecretString?.GenerateStringKey === "token"
    );
    expect(hits).toHaveLength(1);
    return hits[0][0];
  };

  test("only the knowledge base role may invoke lambdaKnowledgeBase", () => {
    const kbRole = roleOf("lambdaKnowledgeBase");
    const invokers = policyStatements().filter(
      ({ statement }) =>
        statement.Effect === "Allow" &&
        [statement.Action].flat().some((a: string) => a === "lambda:InvokeFunction" || a === "lambda:*") &&
        JSON.stringify(statement.Resource).includes("lambdaKnowledgeBase")
    );
    expect(invokers.length).toBeGreaterThan(0);
    for (const { roles } of invokers) expect(roles).toEqual([kbRole]);
  });

  test("the worker invoke secret is readable only by the knowledge base role and wired to it", () => {
    const secretId = workerInvokeSecretId();
    const readers = policyStatements().filter(({ statement }) =>
      JSON.stringify(statement.Resource ?? "").includes(`"Ref":"${secretId}"`)
    );
    expect(readers.length).toBeGreaterThan(0);
    for (const { roles, statement } of readers) {
      expect(roles).toEqual([roleOf("lambdaKnowledgeBase")]);
      expect([statement.Action].flat()).toContain("secretsmanager:GetSecretValue");
    }
    expect(resources.lambdaKnowledgeBase.Properties.Environment.Variables.WORKER_INVOKE_SECRET_ARN).toEqual({
      Ref: secretId,
    });
  });

  test("the admin user pool requires TOTP MFA and keeps its logical ID", () => {
    const pools = Object.entries(resources).filter(([, r]) => r.Type === "AWS::Cognito::UserPool");
    expect(pools).toHaveLength(1);
    const [poolId, pool] = pools[0];
    // Recorded before the MFA change; a different ID would mean pool replacement.
    expect(poolId).toBe("KCApipoolA08D0866");
    expect(pool.Properties.MfaConfiguration).toBe("ON");
    expect(pool.Properties.EnabledMfas).toEqual(["SOFTWARE_TOKEN_MFA"]);
    expect(pool.Properties.SmsConfiguration).toBeUndefined();
    expect(pool.Properties.DeletionProtection).toBe("ACTIVE");
    expect(pool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(true);
    expect(pool.DeletionPolicy).toBe("Retain");
    expect(pool.UpdateReplacePolicy).toBe("Retain");
  });

  // --- Finding f-81bbc719: identity pool role mapping ---------------------

  const onlyOf = (type: string): [string, any] => {
    const hits = Object.entries(resources).filter(([, r]) => r.Type === type);
    expect(hits).toHaveLength(1);
    return hits[0];
  };

  const adminGroupRoleId = (): string => {
    const groups = Object.values(resources).filter(
      (r) => r.Type === "AWS::Cognito::UserPoolGroup" && r.Properties.GroupName === "admin"
    );
    expect(groups).toHaveLength(1);
    return groups[0].Properties.RoleArn["Fn::GetAtt"][0];
  };

  test("the identity pool issues no unauthenticated identities", () => {
    const [, pool] = onlyOf("AWS::Cognito::IdentityPool");
    expect(pool.Properties.AllowUnauthenticatedIdentities).toBe(false);
  });

  test("the default authenticated role is not the admin role and holds no permissions", () => {
    const [, attachment] = onlyOf("AWS::Cognito::IdentityPoolRoleAttachment");
    const authRoleId = attachment.Properties.Roles.authenticated["Fn::GetAtt"][0];
    expect(authRoleId).not.toBe(adminGroupRoleId());
    expect(statementsFor(authRoleId)).toEqual([]);
    expect(resources[authRoleId].Properties.ManagedPolicyArns).toBeUndefined();
    expect(resources[authRoleId].Properties.Policies).toBeUndefined();
  });

  test("user pool identities resolve roles from the token and deny when ambiguous", () => {
    const [, attachment] = onlyOf("AWS::Cognito::IdentityPoolRoleAttachment");
    const [poolId] = onlyOf("AWS::Cognito::UserPool");
    const [clientId] = onlyOf("AWS::Cognito::UserPoolClient");
    const mapping = attachment.Properties.RoleMappings.userPool;
    expect(mapping.Type).toBe("Token");
    expect(mapping.AmbiguousRoleResolution).toBe("Deny");
    const provider = JSON.stringify(mapping.IdentityProvider);
    expect(provider).toContain(`"Fn::GetAtt":["${poolId}","ProviderName"]`);
    expect(provider).toContain(`"Ref":"${clientId}"`);
  });

  test("the admin role trusts only authenticated identities from this user pool", () => {
    const [poolId] = onlyOf("AWS::Cognito::UserPool");
    const [identityPoolId] = onlyOf("AWS::Cognito::IdentityPool");
    const trust = resources[adminGroupRoleId()].Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    const cond = trust[0].Condition;
    expect(cond.StringEquals["cognito-identity.amazonaws.com:aud"]).toEqual({ Ref: identityPoolId });
    expect(cond["ForAnyValue:StringLike"]["cognito-identity.amazonaws.com:amr"]).toBe("authenticated");
    expect(cond["ForAnyValue:StringEquals"]["cognito-identity.amazonaws.com:amr"]).toEqual({
      "Fn::GetAtt": [poolId, "ProviderName"],
    });
  });

  test("execute-api grants name this REST API and no stale /instructor/ path", () => {
    const [apiId] = onlyOf("AWS::ApiGateway::RestApi");
    const invokes = policyStatements().filter(({ statement }) =>
      [statement.Action].flat().includes("execute-api:Invoke")
    );
    expect(invokes.length).toBeGreaterThan(0);
    for (const { statement } of invokes) {
      for (const arn of [statement.Resource].flat()) {
        const json = JSON.stringify(arn);
        expect(json).toContain(`"Ref":"${apiId}"`);
        expect(json).not.toContain(":*/");
        expect(json).not.toContain("/instructor/");
      }
    }
  });

  // Finding f-a52b51f4: a service-principal permission with no SourceArn lets any
  // account's API Gateway invoke the function (confused deputy).
  test("every API Gateway invoke permission is pinned to this account", () => {
    const perms = Object.values(resources).filter(
      (r: any) =>
        r.Type === "AWS::Lambda::Permission" &&
        r.Properties.Principal === "apigateway.amazonaws.com"
    );
    expect(perms.length).toBeGreaterThan(0);
    for (const p of perms as any[]) {
      expect(JSON.stringify(p.Properties.SourceArn ?? "")).toContain(
        `:execute-api:${env.region}:${env.account}:`
      );
    }
    for (const fn of ["adminLambdaAuthorizer", "userLambdaAuthorizer"]) {
      const own = (perms as any[]).filter(
        (p) => JSON.stringify(p.Properties.FunctionName).includes(`"${fn}"`)
      );
      expect(own.map((p) => p.Properties.SourceArn)).toEqual([
        `arn:aws:execute-api:${env.region}:${env.account}:*/authorizers/*`,
      ]);
    }
  });

  test("no intra-stack dependency cycle", () => {
    const ids = new Set(Object.keys(resources));
    const refs = (node: any, out: Set<string>): Set<string> => {
      if (Array.isArray(node)) {
        node.forEach((n) => refs(n, out));
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries<any>(node)) {
          if (k === "Ref" && typeof v === "string" && ids.has(v)) out.add(v);
          else if (k === "Fn::GetAtt") {
            const n = Array.isArray(v) ? v[0] : String(v).split(".")[0];
            if (ids.has(n)) out.add(n);
          } else if (k === "Fn::Sub") {
            const s = Array.isArray(v) ? v[0] : v;
            for (const m of String(s).matchAll(/\$\{([A-Za-z0-9]+)(\.[A-Za-z0-9.]+)?\}/g)) {
              if (ids.has(m[1])) out.add(m[1]);
            }
            if (Array.isArray(v)) refs(v[1], out);
          } else refs(v, out);
        }
      }
      return out;
    };
    const graph: Record<string, string[]> = {};
    for (const [id, r] of Object.entries(resources)) {
      const deps = refs(r.Properties || {}, new Set());
      for (const d of [r.DependsOn || []].flat()) deps.add(d);
      graph[id] = [...deps];
    }
    const state: Record<string, number> = {};
    const cycles: string[] = [];
    const dfs = (n: string, stack: string[]) => {
      state[n] = 1;
      stack.push(n);
      for (const m of graph[n] || []) {
        if (state[m] === 1) cycles.push(stack.slice(stack.indexOf(m)).concat(m).join(" -> "));
        else if (!state[m]) dfs(m, stack);
      }
      stack.pop();
      state[n] = 2;
    };
    for (const n of Object.keys(graph)) if (!state[n]) dfs(n, []);
    expect(cycles).toEqual([]);
  });
});
