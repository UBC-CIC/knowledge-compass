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

/**
 * Routes dispatched from KB helper modules through a `_ROUTES` table, e.g.
 *   ("GET", "/admin/embedding-spaces", re.compile(...)),
 * main.py only calls is_*_route(event) for these, so the pythonRoutes() scan above
 * never sees them. Each entry must be documented or API Gateway cannot reach it.
 */
const KB_ROUTE_TABLES = ["embedding_admin.py", "guideline_admin.py"].map((file) =>
  path.join(CDK_ROOT, "lambda", "knowledgeBase", "helpers", file),
);

function helperTableRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  const entry = /\(\s*"(GET|POST|PUT|DELETE|PATCH)",\s*"(\/[A-Za-z0-9_\-/{}]*)",\s*re\.compile\(/g;
  for (const file of KB_ROUTE_TABLES) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(entry)) {
      routes.set(`${match[1]} ${match[2]}`, path.basename(file));
    }
  }
  return routes;
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

  test("every knowledgeBase helper route table entry is documented", () => {
    const routes = helperTableRoutes();
    // Guard against the extractor silently matching nothing.
    expect(routes.size).toBeGreaterThanOrEqual(14);
    expect([...routes.keys()]).toEqual(
      expect.arrayContaining([
        "GET /admin/embedding-models",
        "GET /admin/embedding-spaces",
        "POST /admin/embedding-spaces/{id}/activate",
        "POST /admin/embedding-spaces/{id}/rollback",
        "POST /admin/embedding-spaces/{id}/purge",
        "GET /admin/embedding-jobs/{id}",
        "PUT /admin/guideline/mode",
      ]),
    );
    const undocumented = [...routes]
      .filter(([route]) => !documented.has(route))
      .map(([route, file]) => `${route} (${file})`);
    expect(undocumented).toEqual([]);
  });

  test("the sync-starting routes document the CUTOVER_LOCKED conflict", () => {
    const ops = [
      ["/admin/data_sources", "post"],
      ["/admin/data_sources/sync", "post"],
      ["/admin/data_sources/batch", "post"],
      ["/admin/data_sources/{id}/retry", "post"],
    ];
    const missing = ops.filter(([p, m]) => {
      const op = spec.paths[p]?.[m] as { responses?: Record<string, { description?: string }> } | undefined;
      return !/CUTOVER_LOCKED/.test(op?.responses?.["409"]?.description ?? "");
    });
    expect(missing).toEqual([]);
  });

  test("embedding admin operations are protected by the admin authorizer", () => {
    const unprotected = Object.entries(spec.paths)
      .filter(([p]) => p.startsWith("/admin/embedding-"))
      .flatMap(([p, ops]) =>
        Object.entries(ops)
          .filter(([m]) => HTTP_METHODS.includes(m))
          .filter(([, op]) => {
            const security = (op as { security?: Array<Record<string, unknown>> }).security ?? [];
            return !security.some((s) => "adminAuthorizer" in s);
          })
          .map(([m]) => `${m.toUpperCase()} ${p}`),
      );
    expect(unprotected).toEqual([]);
  });
});
