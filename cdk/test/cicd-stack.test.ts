import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { spawnSync } from "child_process";
import * as fs from "fs";
import {
  CICDStack,
  ECR_SCAN_ALLOWED_FINDINGS,
  ECR_SCAN_GATE_SCRIPT,
  scanAllowListEnv,
} from "../lib/cicd-stack";

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
      "cdk && PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s containers/tests",
    ]) {
      expect(buildSpec).toContain(step);
    }
  });

  test("legacy vectorIndexManagerSigV4 resources are gone", () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/vectorIndexManager/i);
  });

  function builderBuildSpec(): string {
    const projects = template.findResources("AWS::CodeBuild::Project", {
      Properties: { Name: "KC-CICD-crawlerBuilder" },
    });
    return String(Object.values(projects)[0].Properties.Source.BuildSpec);
  }

  test("image builder pushes only the candidate tag and runs the scan gate", () => {
    const buildSpec = builderBuildSpec();
    expect(buildSpec).not.toContain("docker push $REPOSITORY_URI:latest");
    expect(buildSpec).not.toContain("docker tag $REPOSITORY_URI:$IMAGE_TAG $REPOSITORY_URI:latest");
    expect(buildSpec).not.toContain("sleep 30");
    expect(buildSpec).not.toContain('|| echo \\"0\\"');
    expect(buildSpec).toContain(
      `base64 -d > /tmp/ecr-scan-gate.sh && SCAN_ALLOWED_FINDINGS=\\"${scanAllowListEnv(ECR_SCAN_ALLOWED_FINDINGS)}\\" bash /tmp/ecr-scan-gate.sh`
    );
    expect(buildSpec).toContain(
      "export IMAGE_TAG=${MODULE_NAME}-${ENVIRONMENT}-${COMMIT_HASH}-${CODEBUILD_BUILD_NUMBER}"
    );

    const encoded = /echo ([A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/ecr-scan-gate\.sh/.exec(buildSpec);
    expect(encoded).not.toBeNull();
    expect(Buffer.from(encoded![1], "base64").toString("utf8")).toBe(ECR_SCAN_GATE_SCRIPT);
  });

  test("repository stays mutable and expires old candidates while keeping latest", () => {
    const repos = template.findResources("AWS::ECR::Repository");
    const [repo] = Object.values(repos);
    expect(repo.Properties.ImageTagMutability).toBe("MUTABLE");
    const rules = JSON.parse(repo.Properties.LifecyclePolicy.LifecyclePolicyText).rules;
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rulePriority: 1,
          selection: expect.objectContaining({
            tagStatus: "tagged",
            tagPrefixList: ["latest"],
            countType: "imageCountMoreThan",
            countNumber: 1,
          }),
        }),
        expect.objectContaining({
          rulePriority: 2,
          selection: expect.objectContaining({
            tagStatus: "tagged",
            tagPrefixList: ["crawler-dev-"],
            countNumber: 30,
          }),
        }),
        expect.objectContaining({
          rulePriority: 3,
          selection: expect.objectContaining({ tagStatus: "untagged", countType: "sinceImagePushed" }),
        }),
      ])
    );
  });

  test("scan gate ECR permissions are scoped to the repository ARN", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[]
    );
    const gate = statements.find(
      (s) => Array.isArray(s.Action) && s.Action.includes("ecr:PutImage")
    );
    expect(gate).toBeDefined();
    expect(gate!.Action).toEqual(
      expect.arrayContaining([
        "ecr:DescribeImages",
        "ecr:DescribeImageScanFindings",
        "ecr:BatchGetImage",
        "ecr:PutImage",
      ])
    );
    const resources = ([] as unknown[]).concat(gate!.Resource);
    expect(resources).toContain("arn:aws:ecr:ca-central-1:111111111111:repository/kc-cicd-crawler");
    expect(resources).not.toContain("*");
  });
});

// Runs the exact shipped gate script against stubbed `aws`/`docker` shell
// functions (no AWS access). Everything goes through stdin so it works with
// Linux bash, Git Bash, or WSL.
describe("ECR scan gate script", () => {
  const bash =
    process.platform === "win32" && fs.existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
      ? "C:\\Program Files\\Git\\bin\\bash.exe"
      : "bash";
  const candidateDigest = "sha256:aaaa";
  // Process spawns are slow under Git Bash on Windows.
  jest.setTimeout(60000);

  interface Mock {
    statuses?: string; // space-separated sequence; last value repeats
    critical?: string;
    high?: string;
    names?: string; // finding names the CRITICAL/HIGH listing returns
    allowed?: string; // SCAN_ALLOWED_FINDINGS
    currentLatest?: string; // digest `latest` resolves to before promotion
    lambdaExists?: boolean;
    succeeding?: string;
  }

  function runGate(mock: Mock = {}): { status: number | null; stderr: string; stdout: string } {
    const prelude = `
export REPO_NAME=kc-cicd-crawler
export REPOSITORY_URI=111111111111.dkr.ecr.ca-central-1.amazonaws.com/kc-cicd-crawler
export IMAGE_TAG=crawler-dev-abc1234-7
export LAMBDA_FUNCTION_NAME=KC-Ingestion-Crawler
export SCAN_POLL_INTERVAL=0
export SCAN_MAX_ATTEMPTS=3
export CODEBUILD_BUILD_SUCCEEDING=${mock.succeeding ?? "1"}
export SCAN_ALLOWED_FINDINGS="${mock.allowed ?? ""}"
MOCK_DIR=$(mktemp -d)
trap 'cat "$MOCK_DIR/calls" >&2; rm -rf "$MOCK_DIR"' EXIT
: > "$MOCK_DIR/calls"
echo 0 > "$MOCK_DIR/n"
echo "${mock.currentLatest ?? "NONE"}" > "$MOCK_DIR/latest"
MOCK_STATUSES="${mock.statuses ?? "COMPLETE"}"
MOCK_CRITICAL="${mock.critical ?? "None"}"
MOCK_HIGH="${mock.high ?? "None"}"
MOCK_NAMES="${mock.names ?? "CVE-2099-0001"}"
MOCK_LAMBDA_EXISTS="${mock.lambdaExists === false ? "0" : "1"}"
docker() { echo "CALL: docker $*" >> "$MOCK_DIR/calls"; }
aws() {
  echo "CALL: $*" >> "$MOCK_DIR/calls"
  case "$1 $2" in
    "ecr describe-images")
      case "$*" in
        *imageTag=latest*)
          local d; d=$(cat "$MOCK_DIR/latest")
          if [ "$d" = "NONE" ]; then echo "An error occurred (ImageNotFoundException)" >&2; return 254; fi
          echo "$d" ;;
        *) echo "${candidateDigest}" ;;
      esac ;;
    "ecr describe-image-scan-findings")
      case "$*" in
        *imageScanStatus.status*)
          local n; n=$(cat "$MOCK_DIR/n"); echo $((n + 1)) > "$MOCK_DIR/n"
          local arr=($MOCK_STATUSES); local i=$n
          [ "$i" -ge "\${#arr[@]}" ] && i=$((\${#arr[@]} - 1))
          case "\${arr[$i]}" in
            ScanNotFound) echo "An error occurred (ScanNotFoundException) when calling DescribeImageScanFindings" >&2; return 254 ;;
            AccessDenied) echo "An error occurred (AccessDeniedException)" >&2; return 254 ;;
            *) echo "\${arr[$i]}" ;;
          esac ;;
        *findingSeverityCounts*) printf '%s\t%s\n' "$MOCK_CRITICAL" "$MOCK_HIGH" ;;
        *"].name"*) echo "$MOCK_NAMES" ;;
        *) echo "CVE-2099-0001 | openssl | 1.0" ;;
      esac ;;
    "ecr batch-get-image")
      case "$*" in
        *imageManifestMediaType*) echo "application/vnd.docker.distribution.manifest.v2+json" ;;
        *) echo '{"schemaVersion":2}' ;;
      esac ;;
    "ecr put-image")
      echo "${candidateDigest}" > "$MOCK_DIR/latest" ;;
    "lambda get-function")
      [ "$MOCK_LAMBDA_EXISTS" = "1" ] || { echo "ResourceNotFoundException" >&2; return 254; } ;;
    "lambda update-function-code") ;;
    *) echo "unexpected aws call: $*" >&2; return 99 ;;
  esac
}
`;
    const result = spawnSync(bash, ["-s"], {
      input: prelude + ECR_SCAN_GATE_SCRIPT,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  }

  const putLatest = "CALL: ecr put-image --repository-name kc-cicd-crawler --image-tag latest";

  function expectNoLatestPush(stderr: string) {
    expect(stderr).not.toMatch(/CALL: docker push \S*:latest/);
  }

  test("0 CRITICAL promotes the scanned digest to latest and updates the Lambda", () => {
    const r = runGate();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("CALL: docker push 111111111111.dkr.ecr.ca-central-1.amazonaws.com/kc-cicd-crawler:crawler-dev-abc1234-7");
    expect(r.stderr).toContain(putLatest);
    expect(r.stderr).toContain(`--image-digest ${candidateDigest}`);
    expect(r.stderr).toContain("CALL: lambda update-function-code");
    // The Lambda is pinned to the scanned digest, not the mutable tag.
    expect(r.stderr).toContain(`@${candidateDigest}`);
    expect(r.stdout).toContain(`latest now points to ${candidateDigest}`);
    expectNoLatestPush(r.stderr);
  });

  test("CRITICAL findings block the build without touching latest", () => {
    const r = runGate({ critical: "2", currentLatest: "sha256:previous" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("Blocking vulnerabilities found (CRITICAL: 2, HIGH: 0): CVE-2099-0001.");
    expect(r.stdout).toContain("CVE-2099-0001");
    expect(r.stderr).not.toContain("CALL: ecr put-image");
    expect(r.stderr).not.toContain("CALL: lambda update-function-code");
    expectNoLatestPush(r.stderr);
  });

  test("HIGH findings block the build without touching latest", () => {
    const r = runGate({ high: "3", names: "CVE-2099-0002", currentLatest: "sha256:previous" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("Blocking vulnerabilities found (CRITICAL: 0, HIGH: 3): CVE-2099-0002.");
    expect(r.stderr).not.toContain("CALL: ecr put-image");
    expect(r.stderr).not.toContain("CALL: lambda update-function-code");
    expectNoLatestPush(r.stderr);
  });

  test("allow-listed findings are reported and the image is promoted", () => {
    const r = runGate({ critical: "1", high: "1", names: "CVE-2099-0001 CVE-2099-0002", allowed: "CVE-2099-0001 CVE-2099-0002" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Allow-listed finding: CVE-2099-0001");
    expect(r.stdout).toContain("Allow-listed finding: CVE-2099-0002");
    expect(r.stderr).toContain(putLatest);
  });

  test("a finding not on the allow-list still blocks", () => {
    const r = runGate({ high: "2", names: "CVE-2099-0001 CVE-2099-0002", allowed: "CVE-2099-0001" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("HIGH: 2): CVE-2099-0002.");
    expect(r.stdout).not.toMatch(/\): CVE-2099-0001/);
    expect(r.stderr).not.toContain("CALL: ecr put-image");
  });

  test("an allow-list entry must match the whole finding name", () => {
    const r = runGate({ high: "1", names: "CVE-2099-00011", allowed: "CVE-2099-0001" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("CALL: ecr put-image");
  });

  test("counts with no listable findings fail closed", () => {
    const r = runGate({ high: "1", names: "None" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("no findings could be listed");
    expect(r.stderr).not.toContain("CALL: ecr put-image");
  });

  test("an unexpected severity count fails closed", () => {
    const r = runGate({ high: "lots" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("Unexpected HIGH count 'lots'");
    expect(r.stderr).not.toContain("CALL: ecr put-image");
  });

  test("FAILED scan status blocks the build", () => {
    const r = runGate({ statuses: "FAILED" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("status FAILED");
    expect(r.stderr).not.toContain("CALL: ecr put-image");
  });

  test("scan that never completes times out and blocks the build", () => {
    const r = runGate({ statuses: "IN_PROGRESS" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("Timed out");
    expect((r.stderr.match(/imageScanStatus\.status/g) ?? []).length).toBe(3);
    expect(r.stderr).not.toContain("CALL: ecr put-image");
  });

  test("scan status lookup errors fail closed", () => {
    const r = runGate({ statuses: "AccessDenied COMPLETE" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("Scan status lookup failed");
    expect((r.stderr.match(/imageScanStatus\.status/g) ?? []).length).toBe(1);
    expect(r.stderr).not.toContain("CALL: ecr put-image");
  });

  test("ScanNotFound right after push is retried", () => {
    const r = runGate({ statuses: "ScanNotFound IN_PROGRESS COMPLETE" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(putLatest);
  });

  test("failed build phase pushes nothing", () => {
    const r = runGate({ succeeding: "0" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("CALL: docker push");
    expect(r.stderr).not.toContain("CALL: ecr put-image");
  });

  test("latest already on the candidate digest skips put-image", () => {
    const r = runGate({ currentLatest: candidateDigest });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("CALL: ecr put-image");
    expect(r.stderr).toContain("CALL: lambda update-function-code");
  });

  test("missing Lambda skips the update after promotion", () => {
    const r = runGate({ lambdaExists: false });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(putLatest);
    expect(r.stderr).not.toContain("CALL: lambda update-function-code");
  });
});

describe("ECR scan allow-list", () => {
  test("every shipped entry has a valid name and a reason", () => {
    expect(() => scanAllowListEnv(ECR_SCAN_ALLOWED_FINDINGS)).not.toThrow();
  });

  test("joins names with spaces", () => {
    expect(scanAllowListEnv({ "CVE-2099-0001": "no fix yet", "GHSA-xxxx.1": "base image" })).toBe(
      "CVE-2099-0001 GHSA-xxxx.1"
    );
  });

  test("rejects names that could break the buildspec command", () => {
    expect(() => scanAllowListEnv({ 'CVE-1"; rm -rf /': "x" })).toThrow(/Invalid/);
    expect(() => scanAllowListEnv({ "CVE 1": "x" })).toThrow(/Invalid/);
  });

  test("rejects entries without a reason", () => {
    expect(() => scanAllowListEnv({ "CVE-2099-0001": " " })).toThrow(/needs a reason/);
  });
});
