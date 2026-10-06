// node --test cdk/lambda/db_setup/tests/plainSituationSteps.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanSteps, seed } = require("../migrations/028_plain_situation_steps");
const { seed: seed024 } = require("../migrations/024_journey_cluster_prompts");

const words = (text) => text.split(/\s+/).filter(Boolean);

test("cleanSteps keeps every word of every seeded situation", () => {
  for (const c of seed024.clusters) {
    const original = words(c.responsePattern);
    if (original[0] === "Response" && original[1] === "pattern:") original.splice(0, 2);
    assert.deepEqual(words(cleanSteps(c.responsePattern)), original, c.key);
  }
});

test("cleanSteps is idempotent", () => {
  for (const c of seed024.clusters) {
    const once = cleanSteps(c.responsePattern);
    assert.equal(cleanSteps(once), once, c.key);
  }
});

test("cleanSteps removes the heading and unwraps items, keeping sub-headings", () => {
  const text = [
    "Response pattern:",
    "1. Explain clearly: a student attending less",
    "   than the full day.",
    "2. Offer next step.",
    "",
    "Response pattern for denial:",
    "1. Acknowledge.",
    "",
    "Key distinctions:",
    "- Informal PDA: not documented,",
    "  evolves gradually.",
  ].join("\n");
  assert.equal(
    cleanSteps(text),
    [
      "1. Explain clearly: a student attending less than the full day.",
      "2. Offer next step.",
      "",
      "Response pattern for denial:",
      "1. Acknowledge.",
      "",
      "Key distinctions:",
      "- Informal PDA: not documented, evolves gradually.",
    ].join("\n")
  );
});

test("seed exposes cleaned steps for every seeded situation", () => {
  assert.deepEqual(Object.keys(seed.steps).sort(), seed024.clusters.map((c) => c.key).sort());
  for (const text of Object.values(seed.steps)) assert.ok(!text.startsWith("Response pattern:"));
});
