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
let ingestionResources: Resources;

const SPLIT_FUNCTIONS = [
  "adminLambdaAuthorizer",
  "userLambdaAuthorizer",
  "userFunction",
  "lambdaTextGen",
  "lambdaKnowledgeBase",
  "chatSessionFunction",
  "systemMessagesFunction",
  "adminFunction",
];
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
  ingestionResources = Template.fromStack(ingestionStack).toJSON().Resources;
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
  test("no role other than the Cognito trigger and admin-provisioning roles holds a cognito-idp action", () => {
    const allowed = new Set([cognitoTriggerRole(), roleOf("adminProvisioningFunction")]);
    for (const roleId of allRoleIds()) {
      if (allowed.has(roleId)) continue;
      expect(allowActionsFor(roleId).filter((a) => a.startsWith("cognito-idp:"))).toEqual([]);
    }
  });

  test("admin provisioning has its own role, may only create, read and group users on this pool, and is capped by its own boundary", () => {
    const roleId = roleOf("adminProvisioningFunction");
    const onRole = Object.entries(resources)
      .filter(([, r]) => r.Type === "AWS::Lambda::Function" && r.Properties.Role["Fn::GetAtt"]?.[0] === roleId)
      .map(([id]) => id);
    expect(onRole).toEqual(["adminProvisioningFunction"]);

    const poolId = Object.entries(resources).find(([, r]) => r.Type === "AWS::Cognito::UserPool")![0];
    const cognitoStatements = statementsFor(roleId).filter((s) =>
      [s.Action].flat().some((a: string) => a.startsWith("cognito-idp:"))
    );
    expect(cognitoStatements).toHaveLength(1);
    expect([cognitoStatements[0].Action].flat().sort()).toEqual([
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
    ]);
    expect(cognitoStatements[0].Resource).toEqual({ "Fn::GetAtt": [poolId, "Arn"] });

    const boundaries = Object.entries(resources).filter(
      ([, r]) =>
        r.Type === "AWS::IAM::ManagedPolicy" && r.Properties.ManagedPolicyName === "KC-Api-AdminProvisioningBoundary"
    );
    expect(boundaries).toHaveLength(1);
    const [boundaryId, boundary] = boundaries[0];
    expect(resources[roleId].Properties.PermissionsBoundary).toEqual({ Ref: boundaryId });
    const stmts: any[] = boundary.Properties.PolicyDocument.Statement;
    const allowAll = stmts.find((s) => s.NotAction);
    expect([allowAll.NotAction].flat().sort()).toEqual(["cognito-idp:*", "iam:*"]);
    const cognitoAllowed = stmts
      .filter((s) => s.Effect === "Allow" && s.Action)
      .flatMap((s) => [s.Action].flat());
    expect(cognitoAllowed.sort()).toEqual([
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
    ]);
  });

  test("admin provisioning reads the email domain allow-list itself (finding f-87e4994d)", () => {
    const fn = resources["adminProvisioningFunction"];
    expect(fn.Properties.Environment.Variables.ALLOWED_EMAIL_DOMAINS).toBe("/KC/AllowedEmailDomains");
    const reads = statementsFor(roleOf("adminProvisioningFunction")).filter(
      (s) => s.Effect === "Allow" && [s.Action].flat().includes("ssm:GetParameter")
    );
    expect(reads.map((s) => s.Resource)).toContainEqual(
      `arn:aws:ssm:${env.region}:${env.account}:parameter/KC/AllowedEmailDomains`
    );
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

  test("every request-handling function has its own role (no shared role, A-07)", () => {
    const splitRoles = SPLIT_FUNCTIONS.map(roleOf);
    expect(new Set(splitRoles).size).toBe(SPLIT_FUNCTIONS.length);
    for (const roleId of splitRoles) {
      const users = Object.values(resources).filter(
        (r) => r.Type === "AWS::Lambda::Function" && r.Properties.Role["Fn::GetAtt"]?.[0] === roleId
      );
      expect(users).toHaveLength(1);
    }
    expect(Object.values(resources).some(
      (r) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === "KC-Api-postgresLambdaRole"
    )).toBe(false);
  });

  test("authorizer, public-token, chat session, system messages and admin roles hold only secret/SSM/X-Ray reads", () => {
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
      systemMessagesFunction: "AWSLambdaVPCAccessExecutionRole",
      adminFunction: "AWSLambdaVPCAccessExecutionRole",
    };
    for (const [fnId, policyName] of Object.entries(managed)) {
      const roleId = roleOf(fnId);
      for (const action of allowActionsFor(roleId)) expect(allowed).toContain(action);
      const arns = JSON.stringify(resources[roleId].Properties.ManagedPolicyArns);
      expect(arns).toContain(policyName);
    }
  });

  test("the guest retention job has its own role with only DB secret reads, on a daily schedule", () => {
    const fnId = fnIdByName("KC-Api-retentionFunction");
    const roleId = roleOf(fnId);
    const otherRoles = Object.entries(resources)
      .filter(([id, r]) => id !== fnId && r.Type === "AWS::Lambda::Function")
      .map(([, r]) => r.Properties.Role?.["Fn::GetAtt"]?.[0]);
    expect(otherRoles).not.toContain(roleId);
    for (const action of allowActionsFor(roleId)) {
      expect(["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]).toContain(action);
    }
    expect(JSON.stringify(resources[roleId].Properties.ManagedPolicyArns)).toContain("AWSLambdaVPCAccessExecutionRole");

    const rules = Object.values(resources).filter(
      (r: any) => r.Type === "AWS::Events::Rule" && r.Properties.Name === "KC-Api-GuestRetentionDaily"
    );
    expect(rules).toHaveLength(1);
    expect((rules[0] as any).Properties.ScheduleExpression).toBe("cron(0 9 * * ? *)");
    expect(JSON.stringify((rules[0] as any).Properties.Targets)).toContain(fnId);
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
    const fnIds = [...SPLIT_FUNCTIONS, ...WEBSOCKET_FUNCTION_NAMES.map(fnIdByName)];
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

  test("the worker invoke secret is readable only by the knowledge base role (and its rotation) and wired to it", () => {
    const secretId = workerInvokeSecretId();
    const rotationRole = roleOf(fnIdByName("KC-Api-AppSecretRotation"));
    const readers = policyStatements().filter(({ statement }) =>
      JSON.stringify(statement.Resource ?? "").includes(`"Ref":"${secretId}"`)
    );
    expect(readers.length).toBeGreaterThan(0);
    const kbReaders = readers.filter(({ roles }) => roles[0] !== rotationRole);
    expect(kbReaders.length).toBeGreaterThan(0);
    for (const { roles, statement } of kbReaders) {
      expect(roles).toEqual([roleOf("lambdaKnowledgeBase")]);
      expect([statement.Action].flat()).toContain("secretsmanager:GetSecretValue");
    }
    for (const { roles } of readers.filter(({ roles }) => roles[0] === rotationRole)) {
      expect(roles).toEqual([rotationRole]);
    }
    expect(resources.lambdaKnowledgeBase.Properties.Environment.Variables.WORKER_INVOKE_SECRET_ARN).toEqual({
      Ref: secretId,
    });
  });

  test("the app client cannot write the email attribute (f-eb536a80)", () => {
    const clients = Object.values(resources).filter((r: any) => r.Type === "AWS::Cognito::UserPoolClient") as any[];
    expect(clients).toHaveLength(1);
    const writable = clients[0].Properties.WriteAttributes;
    // Unset or empty would leave every attribute writable.
    expect(Array.isArray(writable) && writable.length > 0).toBe(true);
    expect(writable).not.toContain("email");
  });

  // TEMPORARY (prototype): MFA is OFF in api-stack.ts. When it is restored,
  // put back the "ON" and ["SOFTWARE_TOKEN_MFA"] assertions below.
  test("the admin user pool (MFA temporarily off) keeps its logical ID", () => {
    const pools = Object.entries(resources).filter(([, r]) => r.Type === "AWS::Cognito::UserPool");
    expect(pools).toHaveLength(1);
    const [poolId, pool] = pools[0];
    // Recorded before the MFA change; a different ID would mean pool replacement.
    expect(poolId).toBe("KCApipoolA08D0866");
    expect(pool.Properties.MfaConfiguration).toBe("OFF");
    expect(pool.Properties.EnabledMfas).toBeUndefined();
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

  // Finding A-10: the console test-invoke stage bypasses the authorizers.
  test("no Lambda may be invoked from the API Gateway test-invoke stage", () => {
    const perms = Object.values(resources).filter((r: any) => r.Type === "AWS::Lambda::Permission");
    expect(JSON.stringify(perms)).not.toContain("test-invoke-stage");
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

// Finding A-01: the guardrail also screens the final answer. Asserted on the
// synthesized template so the deployed policy, not just the constants, is covered.
describe("Bedrock guardrail policy", () => {
  const guardrail = () => {
    const found = Object.values(resources).filter((r: any) => r.Type === "AWS::Bedrock::Guardrail");
    expect(found).toHaveLength(1);
    return (found[0] as any).Properties;
  };

  test("content filters screen output only; prompt attacks screen input only", () => {
    const filters = guardrail().ContentPolicyConfig.FiltersConfig;
    const byType = Object.fromEntries(filters.map((f: any) => [f.Type, f]));
    expect(byType.PROMPT_ATTACK).toMatchObject({ InputStrength: "HIGH", OutputStrength: "NONE" });
    for (const type of ["HATE", "INSULTS", "SEXUAL", "VIOLENCE", "MISCONDUCT"]) {
      expect(byType[type].InputStrength).toBe("NONE");
      expect(byType[type].OutputStrength).not.toBe("NONE");
    }
  });

  test("output masks only high-risk identifiers; every entry states its output setting", () => {
    const pii = guardrail().SensitiveInformationPolicyConfig.PiiEntitiesConfig;
    for (const e of pii) expect(typeof e.OutputEnabled).toBe("boolean");
    expect(pii.find((e: any) => e.Type === "NAME").OutputEnabled).toBe(false);
    expect(pii.find((e: any) => e.Type === "URL").OutputEnabled).toBe(false);
    expect(pii.find((e: any) => e.Type === "CA_SOCIAL_INSURANCE_NUMBER")).toMatchObject({
      OutputEnabled: true,
      OutputAction: "ANONYMIZE",
    });
    for (const r of guardrail().SensitiveInformationPolicyConfig.RegexesConfig) {
      expect(r.OutputEnabled).toBe(false);
    }
  });

  test("a new guardrail version is published for this policy", () => {
    const versions = Object.entries(resources).filter(([, r]: [string, any]) => r.Type === "AWS::Bedrock::GuardrailVersion");
    expect(versions).toHaveLength(1);
    expect(versions[0][0]).toMatch(/^InputGuardrailVersion/);
  });
});

// Finding A-02: the Bedrock invoke grant names this account and the regions
// the calls actually use, not any region or account.
describe("Bedrock invoke scope", () => {
  const invokeResources = (fnId: string): string[] =>
    statementsFor(roleOf(fnId))
      .filter((s) => s.Effect === "Allow" && [s.Action].flat().includes("bedrock:Converse"))
      .flatMap((s) => [s.Resource].flat());

  test.each(["lambdaTextGen", "lambdaKnowledgeBase"])("%s: inference profiles are pinned to this region and account", (fnId) => {
    const profiles = invokeResources(fnId).filter((r) => r.includes(":inference-profile/"));
    expect(profiles.length).toBeGreaterThan(0);
    for (const arn of profiles) {
      expect(arn.startsWith(`arn:aws:bedrock:${env.region}:${env.account}:inference-profile/`)).toBe(true);
    }
  });

  test.each(["lambdaTextGen", "lambdaKnowledgeBase"])("%s: Haiku 5.5 is granted only via this account's us. profile and its destination regions", (fnId) => {
    const haiku = invokeResources(fnId).filter((r) => r.includes("claude-haiku-5-5")).sort();
    expect(haiku).toEqual([
      `arn:aws:bedrock:${env.region}:${env.account}:inference-profile/us.anthropic.claude-haiku-5-5`,
      ...["ca-central-1", "us-east-1", "us-east-2", "us-west-2"].map(
        (r) => `arn:aws:bedrock:${r}::foundation-model/anthropic.claude-haiku-5-5`,
      ),
    ].sort());
  });

  test("no Claude model other than Haiku 5.5 is invokable", () => {
    for (const fnId of ["lambdaTextGen", "lambdaKnowledgeBase"]) {
      const claude = invokeResources(fnId).filter((r) => r.includes("anthropic.claude"));
      expect(claude.every((r) => r.includes("claude-haiku-5-5"))).toBe(true);
    }
  });
});

// Finding A-12: only the functions that call the WebSocket management API may, and
// only on the WebSocket stage.
describe("WebSocket ManageConnections scope", () => {
  const manageConnectionsResources = (roleId: string): string[] =>
    statementsFor(roleId)
      .filter((s) => s.Effect === "Allow" && [s.Action].flat().includes("execute-api:ManageConnections"))
      .flatMap((s) => [s.Resource].flat())
      .map((r) => JSON.stringify(r));

  test("only text gen and $default hold ManageConnections", () => {
    const holders = allRoleIds().filter((id) => manageConnectionsResources(id).length > 0);
    expect(holders.sort()).toEqual(
      [roleOf("lambdaTextGen"), roleOf(fnIdByName("KC-Api-DefaultFunction"))].sort()
    );
  });

  test("connect and disconnect hold no ManageConnections", () => {
    for (const name of ["KC-Api-ConnectFunction", "KC-Api-DisconnectFunction"]) {
      expect(allowActionsFor(roleOf(fnIdByName(name)))).not.toContain("execute-api:ManageConnections");
    }
  });

  test("text gen may only POST to connections on the WebSocket stage in this account", () => {
    const res = manageConnectionsResources(roleOf("lambdaTextGen"));
    expect(res).toHaveLength(1);
    expect(res[0]).toContain(`:${env.account}:*/prod/POST/@connections/*`);
    expect(res[0]).toContain(env.region);
  });

  test("$default is pinned to this WebSocket API's id and stage", () => {
    const res = manageConnectionsResources(roleOf(fnIdByName("KC-Api-DefaultFunction")));
    expect(res).toHaveLength(2);
    for (const r of res) {
      expect(r).toContain("ChatWebSocketApi");
      expect(r).toMatch(/\/prod\/(POST|DELETE)\/@connections\/\*/);
    }
  });
});

// Per-IP WebSocket limits (lambda/websocket/ipLimit.js): $connect may update only
// its own "ip#connect#*" counters, never connection bindings or other counters.
describe("WebSocket per-IP counter scope", () => {
  test("connect's UpdateItem is pinned to ip#connect# keys", () => {
    const updates = statementsFor(roleOf(fnIdByName("KC-Api-ConnectFunction")))
      .filter((s) => s.Effect === "Allow" && [s.Action].flat().includes("dynamodb:UpdateItem"));
    expect(updates).toHaveLength(1);
    expect([updates[0].Action].flat()).toEqual(["dynamodb:UpdateItem"]);
    expect(updates[0].Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ip#connect#*"] },
    });
  });

  test("connect and default get the IP hash key and the WS_IP_* limits", () => {
    for (const name of ["KC-Api-ConnectFunction", "KC-Api-DefaultFunction"]) {
      const fn = resources[fnIdByName(name)];
      const vars = fn.Properties.Environment.Variables;
      expect(vars).toMatchObject({
        WS_IP_CONNECT_RATE_LIMIT: "30",
        WS_IP_GENERATE_RATE_LIMIT: "30",
        WS_IP_RATE_WINDOW_SECONDS: "60",
      });
      expect(JSON.stringify(vars.WS_IP_HASH_SECRET)).toContain("WsIpHashSecret");
      expect(allowActionsFor(roleOf(fnIdByName(name)))).toContain("secretsmanager:GetSecretValue");
    }
  });
});

// Finding A-08: the ingestion tasks authenticate to the DB with the Secrets Manager
// credential (RDS Proxy takes no IAM tokens), so their roles get no rds-db:connect.
describe("Ingestion task DB access", () => {
  const taskRoleIds = () =>
    Object.entries(ingestionResources)
      .filter(([id, r]) => r.Type === "AWS::IAM::Role" && /TaskRole/.test(id) && !/Execution/.test(id))
      .map(([id]) => id);

  test("no ingestion role is granted rds-db:connect", () => {
    const actions = Object.values(ingestionResources)
      .filter((r) => r.Type === "AWS::IAM::Policy")
      .flatMap((r) => r.Properties.PolicyDocument.Statement)
      .flatMap((s: any) => [s.Action].flat());
    expect(actions).not.toContain("rds-db:connect");
  });

  test("the crawler and transcriber task roles can still read the DB secret", () => {
    const ids = taskRoleIds();
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const actions = Object.values(ingestionResources)
        .filter((p) => p.Type === "AWS::IAM::Policy" && (p.Properties.Roles || []).some((x: any) => x.Ref === id))
        .flatMap((p) => p.Properties.PolicyDocument.Statement)
        .flatMap((s: any) => [s.Action].flat());
      expect(actions).toContain("secretsmanager:GetSecretValue");
    }
  });
});

// Finding A-15: lost knowledge base worker invocations raise an alarm. The worker
// payload carries the invoke token, so no queue or destination stores it.
describe("Knowledge base async failures", () => {
  test("dropped async invocations alarm to the ops topic", () => {
    const alarms = Object.values(resources).filter(
      (r) => r.Type === "AWS::CloudWatch::Alarm" && r.Properties.MetricName === "AsyncEventsDropped"
    );
    expect(alarms).toHaveLength(1);
    const p = alarms[0].Properties;
    expect(p.Namespace).toBe("AWS/Lambda");
    expect(JSON.stringify(p.Dimensions)).toContain("lambdaKnowledgeBase");
    expect(p.Statistic).toBe("Sum");
    expect(p.Threshold).toBe(0);
    expect(p.ComparisonOperator).toBe("GreaterThanThreshold");
    expect(p.AlarmActions).toHaveLength(1);
  });

  test("no async invoke config sends payloads (and the invoke token) to a destination", () => {
    const configs = Object.values(resources).filter((r) => r.Type === "AWS::Lambda::EventInvokeConfig");
    for (const c of configs) {
      expect(c.Properties.DestinationConfig).toBeUndefined();
    }
    const kb = resources["lambdaKnowledgeBase"].Properties;
    expect(kb.DeadLetterConfig).toBeUndefined();
  });
});

// Finding A-13: the two Python Lambdas import shared code from one layer, not copies.
describe("Shared Python layer", () => {
  const sharedLayerId = () => {
    const ids = Object.entries(resources)
      .filter(([id, r]) => r.Type === "AWS::Lambda::LayerVersion" && id.startsWith("sharedPythonLayer"))
      .map(([id]) => id);
    expect(ids).toHaveLength(1);
    return ids[0];
  };

  test.each(["lambdaTextGen", "lambdaKnowledgeBase"])("%s loads the kc_shared layer", (fnId) => {
    expect(resources[fnId].Properties.Layers).toContainEqual({ Ref: sharedLayerId() });
  });

  test("the layer targets the Python runtime the functions use", () => {
    const layer = resources[sharedLayerId()].Properties;
    expect(layer.CompatibleRuntimes).toEqual(["python3.12"]);
    for (const fnId of ["lambdaTextGen", "lambdaKnowledgeBase"]) {
      expect(resources[fnId].Properties.Runtime).toBe("python3.12");
    }
  });
});

describe("Application secret rotation (f-440374a2)", () => {
  const schedules = () =>
    Object.values(resources).filter((r: any) => r.Type === "AWS::SecretsManager::RotationSchedule") as any[];

  test("the JWT secret and worker invoke token rotate every 90 days, never on deploy", () => {
    const rotated = schedules().map((s) => JSON.stringify(s.Properties.SecretId));
    expect(rotated.some((id) => id.includes("JwtSecret"))).toBe(true);
    expect(rotated.some((id) => id.includes("WorkerInvokeSecret"))).toBe(true);
    for (const schedule of schedules()) {
      expect(schedule.Properties.RotationRules.ScheduleExpression).toBe("rate(90 days)");
      expect(schedule.Properties.RotateImmediatelyOnUpdate).toBe(false);
      expect(JSON.stringify(schedule.Properties.RotationLambdaARN)).toContain(fnIdByName("KC-Api-AppSecretRotation"));
    }
  });

  test("the rotation function's role touches only Secrets Manager", () => {
    const roleId = roleOf(fnIdByName("KC-Api-AppSecretRotation"));
    for (const action of allowActionsFor(roleId)) expect(action).toMatch(/^secretsmanager:/);
  });
});

describe("CORS allow-list seed (f-9ff3f181)", () => {
  test("a fresh deploy trusts no browser origin until the SPA origin is written", () => {
    const seeds = Object.values(resources).filter(
      (r: any) => r.Type === "Custom::AWS" && JSON.stringify(r.Properties.Create ?? "").includes("/API/AllowedOrigins")
    ) as any[];
    expect(seeds).toHaveLength(1);
    const create = JSON.stringify(seeds[0].Properties.Create);
    expect(create).toContain("https://origin-not-configured.invalid");
    expect(create).not.toContain("localhost");
  });
});
