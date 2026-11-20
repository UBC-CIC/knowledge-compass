import {
  GUARDRAIL_BLOCKED_OUTPUT_MESSAGE,
  GUARDRAIL_CONTENT_FILTERS_CONFIG,
  GUARDRAIL_OUTPUT_MASKED_PII,
  GUARDRAIL_PII_ENTITIES_CONFIG,
} from "../lib/api-stack";

// The guardrail is applied to the user's message and to the final answer.
// Input keeps the original policy; output adds harmful-content filters and
// masks only high-risk identifiers (finding A-01).

describe("guardrail PII policy", () => {
  test("every entity is anonymized on input", () => {
    expect(GUARDRAIL_PII_ENTITIES_CONFIG).toHaveLength(20);
    for (const e of GUARDRAIL_PII_ENTITIES_CONFIG) {
      expect(e.action).toBe("ANONYMIZE");
      expect(e.inputAction).toBe("ANONYMIZE");
      expect(e.inputEnabled).toBe(true);
    }
  });

  test("only high-risk identifiers are masked in output", () => {
    const masked = GUARDRAIL_PII_ENTITIES_CONFIG.filter((e) => e.outputEnabled === true);
    expect(masked.map((e) => e.type).sort()).toEqual([...GUARDRAIL_OUTPUT_MASKED_PII].sort());
    for (const e of masked) expect(e.outputAction).toBe("ANONYMIZE");
  });

  test.each(["NAME", "EMAIL", "PHONE", "URL", "AGE"])(
    "%s is never masked in output: answers name organizations, helplines and links",
    (type) => {
      const entry = GUARDRAIL_PII_ENTITIES_CONFIG.find((e) => e.type === type);
      expect(entry?.outputEnabled).toBe(false);
      expect(entry?.outputAction).toBe("NONE");
    },
  );

  test("every output setting is explicit (omitted outputEnabled defaults to on)", () => {
    for (const e of GUARDRAIL_PII_ENTITIES_CONFIG) {
      expect(typeof e.outputEnabled).toBe("boolean");
    }
  });
});

describe("guardrail content filters", () => {
  const byType = Object.fromEntries(GUARDRAIL_CONTENT_FILTERS_CONFIG.map((f) => [f.type, f]));

  test("prompt-attack filtering stays on input only", () => {
    expect(byType.PROMPT_ATTACK).toEqual({ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" });
  });

  test.each(["HATE", "INSULTS", "SEXUAL", "VIOLENCE", "MISCONDUCT"])(
    "%s filters output only, so parents can describe incidents at school",
    (type) => {
      expect(byType[type].inputStrength).toBe("NONE");
      expect(byType[type].outputStrength).not.toBe("NONE");
    },
  );

  test("no filter runs at HIGH on output, to limit false blocks on hard topics", () => {
    for (const f of GUARDRAIL_CONTENT_FILTERS_CONFIG) {
      expect(f.outputStrength).not.toBe("HIGH");
    }
  });

  test("the blocked-answer message is written for families", () => {
    expect(GUARDRAIL_BLOCKED_OUTPUT_MESSAGE).toContain("Knowledge Compass");
    expect(GUARDRAIL_BLOCKED_OUTPUT_MESSAGE).not.toBe("Response blocked.");
  });
});
