/**
 * Tests for utils/publicSources.js stripInternalLinks / toPublicMessage.
 * Mirrors textGeneration/tests/test_citations.py so both sanitizers agree.
 *
 * Run from cdk/:
 *
 *     npm run test:lambda
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stripInternalLinks, toPublicMessage } = require("../utils/publicSources.js");

const INTERNAL = /(s3|upload|csvlink):\/\//;

test("inline internal links keep their text; http links are kept", () => {
  assert.equal(
    stripInternalLinks("See [Handbook](s3://bucket/uploads/h.pdf) and [Guide](upload://document/guide.pdf)."),
    "See Handbook and Guide."
  );
  const http = "See [Site](https://example.org/page) and [Old](http://example.org).";
  assert.equal(stripInternalLinks(http), http);
});

test("bare URIs are removed", () => {
  assert.equal(
    stripInternalLinks("Stored at s3://ingest-bucket/uploads/h.pdf and csvlink://row/12.\nAlso (upload://doc.pdf)."),
    "Stored at  and \nAlso ()."
  );
});

test("autolinks and reference definitions are removed", () => {
  assert.equal(
    stripInternalLinks("See <s3://bucket/key> now.\n[1]: upload://doc.pdf\n  [2]: <csvlink://row/3>\n[3]: https://example.org/"),
    "See  now.\n\n\n[3]: https://example.org/"
  );
});

test("http URLs survive; internal URIs nested in them do not", () => {
  assert.equal(stripInternalLinks("Open https://example.org/a_b today."), "Open https://example.org/a_b today.");
  assert.equal(
    stripInternalLinks("Open https://example.org/view?src=s3://bucket/key today."),
    "Open https://example.org/view?src= today."
  );
});

test("the whole key is removed even inside emphasis", () => {
  assert.equal(stripInternalLinks("See **s3://bucket/my_file.pdf** now"), "See ** now");
  assert.equal(stripInternalLinks("| upload://a_b/c | x |"), "|  | x |");
});

test("no internal URI survives in any form", () => {
  for (const text of [
    "x s3://a/b", "[t](upload://a)", "<csvlink://a>", "[r]: s3://a", "'s3://a'", "`upload://a`",
    "**s3://a/b**", "_upload://a_", ",s3://a", "-csvlink://a", ">s3://a", "|s3://a|", "=s3://a",
  ]) {
    assert.doesNotMatch(stripInternalLinks(text), INTERNAL, text);
  }
});

test("non-strings pass through", () => {
  assert.equal(stripInternalLinks(null), null);
  assert.equal(stripInternalLinks(undefined), undefined);
});

test("toPublicMessage sanitizes AI content only", () => {
  const ai = toPublicMessage({ sender: "AI", content: "From s3://bucket/key and <upload://x>.", sources: [] });
  assert.doesNotMatch(ai.content, INTERNAL);
  const user = { sender: "User", content: "my s3://notes" };
  assert.equal(toPublicMessage(user), user);
});
