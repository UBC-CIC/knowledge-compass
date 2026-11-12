/**
 * Pausing public chat (service status read_only, or the SSM PublicChatEnabled switch) must
 * never lock admins out: the admin console is where chat is resumed. Only textGeneration
 * refuses work while paused; every admin route keeps answering.
 *
 *   node --test cdk/lambda/handlers/tests/readOnlyAdminAccess.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const { fakeSql, loadHandler, quietly } = require("./_loadHandler.js");

const LAMBDA_DIR = path.resolve(__dirname, "../..");
const SWAGGER_PATH = path.resolve(LAMBDA_DIR, "../OpenAPI_Swagger_Definition.yaml");

// ── Static: where the pause is read and where it refuses work ────────────────

function codeFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "__pycache__", "tests"].includes(entry.name) ? [] : codeFiles(full);
    }
    return /\.(js|py)$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file) => path.relative(LAMBDA_DIR, file).split(path.sep).join("/");
const sources = codeFiles(LAMBDA_DIR).map((file) => ({ file: rel(file), text: fs.readFileSync(file, "utf8") }));

test("only textGeneration refuses work while chat is paused", () => {
  const refusing = sources.filter(({ text }) => /SERVICE_READ_ONLY|PUBLIC_CHAT_PAUSED/.test(text)).map((s) => s.file);
  assert.deepEqual(refusing, ["textGeneration/main.py"]);
});

test("the pause is read only by the chat path, the public status read and the settings API that sets it", () => {
  const readers = sources
    .filter(({ text }) => /service_status|is_public_chat_enabled|PUBLIC_CHAT_ENABLED/.test(text))
    .map((s) => s.file)
    .sort();
  assert.deepEqual(readers, [
    "db_setup/migrations/034_service_status.js",
    // PUT/GET /admin/system-settings: sets and shows it, never refuses because of it.
    "handlers/adminHandler.js",
    // GET /system-settings/service-status: the public read for the chat page.
    "handlers/systemMessagesHandler.js",
    "textGeneration/helpers/crud.py",
    "textGeneration/helpers/kill_switch.py",
    "textGeneration/main.py",
  ]);
});

test("no admin route is served by textGeneration", () => {
  const doc = YAML.parse(fs.readFileSync(SWAGGER_PATH, "utf8"), { merge: true });
  const adminFunctions = new Set();
  for (const [route, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === "options" || !op || typeof op !== "object") continue;
      const uri = JSON.stringify(op["x-amazon-apigateway-integration"]?.uri ?? "");
      const fn = (uri.match(/functions\/\$\{(\w+)\.Arn\}/) || [])[1];
      if (route.startsWith("/admin")) {
        adminFunctions.add(fn);
        assert.deepEqual(op.security, [{ adminAuthorizer: [] }], `${method} ${route}`);
      } else if (fn === "lambdaTextGen") {
        assert.equal(route, "/chat_sessions/{chat_session_id}/text_generation");
      }
    }
  }
  assert.deepEqual([...adminFunctions].sort(), ["adminFunction", "adminProvisioningFunction", "lambdaKnowledgeBase"]);
});

// ── Behaviour: the admin API works while chat is paused ──────────────────────

const adminContext = {
  authorizer: { role: "admin", email: "admin@example.com", userId: "11111111-2222-3333-4444-555555555555" },
};
const PAUSED = { service_status: "read_only", service_message: "Back at 3 pm." };

function pausedSql() {
  return fakeSql(
    (text) => {
      if (text.includes("FROM users WHERE cognito_sub")) return [{ id: "u1", role: "admin" }];
      if (text.startsWith("SELECT service_status, service_message")) return [PAUSED];
      if (text.includes("UPDATE system_settings")) return [{ id: "s1", service_status: "normal", service_message: PAUSED.service_message }];
      if (text.includes("WITH latest AS") && text.includes("LEFT JOIN users")) return [{ id: "s1", ...PAUSED }];
      return [];
    },
    { rejectUndefined: true }
  );
}

async function admin(sql, httpMethod, resource, body) {
  const { handler } = loadHandler("adminHandler", sql);
  const res = await quietly(() =>
    handler({ httpMethod, resource, requestContext: adminContext, ...(body && { body: JSON.stringify(body) }) })
  );
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

test("admin reads keep working while chat is paused", async () => {
  for (const resource of ["/admin/system-settings", "/admin/users", "/admin/system-messages", "/admin/data_sources"]) {
    const res = await admin(pausedSql(), "GET", resource);
    assert.equal(res.statusCode, 200, `${resource}: ${JSON.stringify(res.body)}`);
  }
  const settings = await admin(pausedSql(), "GET", "/admin/system-settings");
  assert.equal(settings.body.service_status, "read_only");
});

test("an admin can resume chat while it is paused", async () => {
  const sql = pausedSql();
  const res = await admin(sql, "PUT", "/admin/system-settings", { service_status: "normal" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.service_status, "normal");
  const update = sql.queries().find((q) => q.text.includes("UPDATE system_settings"));
  assert.ok(update.values.includes("normal"));
});
