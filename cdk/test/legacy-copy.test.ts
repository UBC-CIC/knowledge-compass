/**
 * Guards against reintroducing legacy UBC / Specialization Explorer copy into
 * user-facing infrastructure (guardrail messages, Cognito emails) or the
 * frontend. Applied database migrations are historical and intentionally
 * excluded.
 */
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LEGACY_COPY = /UBC Science|Specialization Explorer/;

// The frontend keeps the legacy opener verbatim only to hide it in old chat
// histories (LEGACY_WELCOME_PROMPT); that single constant is allowed.
const ALLOWED = new Set([
  path.join("frontend", "src", "pages", "ChatInterface", "ChatInterface.tsx"),
]);

function listFiles(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", "cdk.out", "__pycache__"].includes(entry.name)
        ? []
        : listFiles(full, exts);
    }
    const isSource = exts.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".d.ts");
    return isSource ? [full] : [];
  });
}

describe("legacy product copy", () => {
  const files = [
    ...listFiles(path.join(REPO_ROOT, "cdk", "lib"), [".ts"]),
    ...listFiles(path.join(REPO_ROOT, "cdk", "bin"), [".ts"]),
    ...listFiles(path.join(REPO_ROOT, "frontend", "src"), [".ts", ".tsx"]),
  ];

  test("source files were found", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("no UBC / Specialization Explorer copy outside the allowed legacy constant", () => {
    const offenders = files
      .map((f) => path.relative(REPO_ROOT, f))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => LEGACY_COPY.test(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });
});
