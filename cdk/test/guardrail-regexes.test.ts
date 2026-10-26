import { GUARDRAIL_REGEXES_CONFIG } from "../lib/api-stack";

// These tests use JS RegExp as a stand-in for Bedrock's regex engine. The
// constructs in the patterns (\b, \d, character classes, (?:), {m,n}) behave
// the same across RE2/Java/JS. Live Bedrock matching needs a deployed guardrail.

function regexFor(name: string): RegExp {
  const entry = GUARDRAIL_REGEXES_CONFIG.find((r) => r.name === name);
  if (!entry) throw new Error(`missing regex ${name}`);
  return new RegExp(entry.pattern, "g");
}

function matches(re: RegExp, text: string): string[] {
  re.lastIndex = 0;
  return text.match(re) ?? [];
}

describe("GUARDRAIL_REGEXES_CONFIG", () => {
  test("has exactly the expected, well-formed entries", () => {
    const names = GUARDRAIL_REGEXES_CONFIG.map((r) => r.name);
    expect(names).toEqual(["CA_POSTAL_CODE", "STREET_ADDRESS"]);
    expect(new Set(names).size).toBe(names.length);
    for (const r of GUARDRAIL_REGEXES_CONFIG) {
      expect(r.pattern.length).toBeLessThanOrEqual(500);
      expect(r.action).toBe("ANONYMIZE");
      expect(r.inputAction).toBe("ANONYMIZE");
      expect(r.inputEnabled).toBe(true);
      // Answers name the addresses of schools and organizations.
      expect(r.outputEnabled).toBe(false);
      for (const lookaround of ["(?=", "(?!", "(?<=", "(?<!"]) {
        expect(r.pattern).not.toContain(lookaround);
      }
    }
  });

  describe("CA_POSTAL_CODE", () => {
    const re = regexFor("CA_POSTAL_CODE");

    test.each(["K1A 0B1", "m5v3l9", "T2P-1J9"])("matches %s", (code) => {
      expect(matches(re, `Our postal code is ${code} if that helps`)).toEqual([code]);
    });

    test.each(["D1A 0B1", "ABC 123"])("does not match %s", (text) => {
      expect(matches(re, text)).toEqual([]);
    });
  });

  describe("STREET_ADDRESS", () => {
    const re = regexFor("STREET_ADDRESS");

    test.each([
      "123 Main Street",
      "45 Maple Ave.",
      "1200 Bay St",
      "7 Elm Crescent",
      "12B Oak Road",
      "300 St. Clair Avenue",
      "55 Côte Drive",
    ])("matches %s inside a sentence", (address) => {
      expect(matches(re, `We live at ${address} in Ottawa`)).toEqual([address]);
    });
  });

  describe("coarse location is not masked", () => {
    test.each([
      "We live in Ontario.",
      "We're in Calgary, Alberta",
      "My son goes to a school in the Toronto District School Board",
      "We moved to Halifax, Nova Scotia last year",
      "Is this different in British Columbia?",
      "She is in grade 3 at Maple Street School",
      "In 2024 Ontario Court decisions changed",
      "My 7 year old is in Grade 2",
    ])("no regex matches %s", (sentence) => {
      for (const r of GUARDRAIL_REGEXES_CONFIG) {
        expect(matches(new RegExp(r.pattern, "g"), sentence)).toEqual([]);
      }
    });
  });
});
