/**
 * Contract checks between the API Gateway OpenAPI definition and the Lambda
 * route handlers. The API is a SpecRestApi, so a handler route missing from
 * the definition is unreachable, and a duplicate path key silently drops one
 * of the definitions.
 */
import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";

const CDK_ROOT = path.resolve(__dirname, "..");
const SWAGGER_PATH = path.join(CDK_ROOT, "OpenAPI_Swagger_Definition.yaml");
const HANDLER_DIR = path.join(CDK_ROOT, "lambda", "handlers");
const KB_MAIN = path.join(CDK_ROOT, "lambda", "knowledgeBase", "main.py");

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];

function parseSwagger() {
  const doc = YAML.parseDocument(fs.readFileSync(SWAGGER_PATH, "utf8"), {
    uniqueKeys: true,
    merge: true,
  });
  return doc;
}

/** Recursively list .js handler sources, skipping tests and dependencies. */
function listHandlerSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["tests", "node_modules"].includes(entry.name) ? [] : listHandlerSources(full);
    }
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

/** Routes declared as exact "METHOD /path" string literals in JS handlers. */
function jsHandlerRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  const literal = /"(GET|POST|PUT|DELETE|PATCH) (\/[A-Za-z0-9_\-/{}]*)"/g;
  for (const file of listHandlerSources(HANDLER_DIR)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(literal)) {
      routes.set(`${match[1]} ${match[2]}`, path.relative(CDK_ROOT, file));
    }
  }
  return routes;
}

/** Routes matched in the knowledgeBase Lambda (method == "X" and (resource == "/path"). */
function pythonRoutes(): string[] {
  const source = fs.readFileSync(KB_MAIN, "utf8");
  const pair = /method == "(GET|POST|PUT|DELETE|PATCH)" and \(\s*resource == "([^"]+)"/g;
  return [...source.matchAll(pair)].map((m) => `${m[1]} ${m[2]}`);
}

describe("OpenAPI definition", () => {
  const doc = parseSwagger();
  const spec = doc.toJS() as { paths: Record<string, Record<string, unknown>> };

  const documented = new Set(
    Object.entries(spec.paths).flatMap(([p, ops]) =>
      Object.keys(ops)
        .filter((m) => HTTP_METHODS.includes(m))
        .map((m) => `${m.toUpperCase()} ${p}`),
    ),
  );

  test("parses without errors or duplicate keys", () => {
    expect(doc.errors.map((e) => e.message)).toEqual([]);
  });

  test("every operation has a Lambda or mock integration", () => {
    const missing = Object.entries(spec.paths).flatMap(([p, ops]) =>
      Object.entries(ops)
        .filter(([m]) => HTTP_METHODS.includes(m))
        .filter(([, op]) => !(op as Record<string, unknown>)["x-amazon-apigateway-integration"])
        .map(([m]) => `${m.toUpperCase()} ${p}`),
    );
    expect(missing).toEqual([]);
  });

  test("no example/test endpoints are exposed", () => {
    expect(Object.keys(spec.paths).filter((p) => /example/i.test(p))).toEqual([]);
  });

  test("every Node.js handler route is reachable through the definition", () => {
    const unreachable = [...jsHandlerRoutes()]
      .filter(([route]) => !documented.has(route))
      .map(([route, file]) => `${route} (${file})`);
    expect(unreachable).toEqual([]);
  });

  test("every knowledgeBase Lambda route is reachable through the definition", () => {
    const routes = pythonRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((r) => !documented.has(r))).toEqual([]);
  });
});
