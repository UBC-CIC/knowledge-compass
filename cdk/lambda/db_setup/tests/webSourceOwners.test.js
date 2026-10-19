// node --test cdk/lambda/db_setup/tests/webSourceOwners.test.js
// Shape checks on migration 038 with a fake `pgm`.
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../migrations/038_web_source_owners");

function run(direction) {
  const calls = [];
  const pgm = new Proxy(
    { sql: (text) => calls.push(text) },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        throw new Error(`migration used pgm.${String(prop)}; only pgm.sql is allowed`);
      },
    }
  );
  migration[direction](pgm);
  return calls.join("\n");
}

const up = run("up");
const down = run("down");
const compact = up.replace(/\s+/g, " ");

test("exports up and down, and both only call pgm.sql", () => {
  assert.equal(typeof migration.up, "function");
  assert.equal(typeof migration.down, "function");
  assert.ok(up.length > 0 && down.length > 0);
});

test("creates the link table with cascading FKs, a composite PK and a data source index", () => {
  assert.match(compact, /CREATE TABLE IF NOT EXISTS web_source_owners/);
  assert.match(compact, /source_id uuid NOT NULL REFERENCES sources\(id\) ON DELETE CASCADE/);
  assert.match(compact, /data_source_id uuid NOT NULL REFERENCES data_sources\(id\) ON DELETE CASCADE/);
  assert.match(compact, /PRIMARY KEY \(source_id, data_source_id\)/);
  assert.match(compact, /CREATE INDEX IF NOT EXISTS idx_web_source_owners_data_source_id ON web_source_owners \(data_source_id\)/);
});

test("backfill links only web pages to website data sources by host equality or dot-suffix", () => {
  assert.match(compact, /INSERT INTO web_source_owners \(source_id, data_source_id\)/);
  assert.match(compact, /ON CONFLICT DO NOTHING/);
  assert.match(compact, /s\.source_type = 'web'::source_type/);
  assert.match(compact, /ds\.type = 'website'::data_source_type/);
  assert.match(compact, /p\.host = w\.host OR right\(p\.host, length\(w\.host\) \+ 1\) = '\.' \|\| w\.host/);
  // Backslashes survive the template literal so the regexes match a literal '.'.
  assert.ok(up.includes("'\\.$'"));
  assert.ok(up.includes("'^www\\.'"));
  assert.doesNotMatch(up, /\bLIKE\b/i);
});

test("purge only removes web rows with no owner", () => {
  assert.match(
    compact,
    /DELETE FROM sources s WHERE s\.source_type = 'web'::source_type AND NOT EXISTS \( SELECT 1 FROM web_source_owners o WHERE o\.source_id = s\.id \)/
  );
});

test("order is create, then backfill, then purge", () => {
  const create = up.indexOf("CREATE TABLE IF NOT EXISTS web_source_owners");
  const backfill = up.indexOf("INSERT INTO web_source_owners");
  const purge = up.indexOf("DELETE FROM sources");
  assert.ok(create >= 0 && create < backfill && backfill < purge);
});

test("down drops the table", () => {
  assert.match(down, /DROP TABLE IF EXISTS web_source_owners/);
});
