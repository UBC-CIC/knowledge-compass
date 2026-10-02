import { describe, expect, it } from "vitest";
import { DEFAULT_JOURNEYS } from "@/components/Admin/defaultJourneys";
import {
  cleanSteps,
  formatQuestions,
  nextJourneyKey,
  nextSituationKey,
  parseQuestions,
  showCounter,
} from "@/lib/promptCatalog";

const words = (text: string) => text.split(/\s+/).filter(Boolean);

describe("questions list", () => {
  it.each(DEFAULT_JOURNEYS.map((j) => [j.key, j.prompts.detective_questions[0].content] as const))(
    "round-trips the seeded %s questions without losing words",
    (_key, text) => {
      const items = parseQuestions(text);
      expect(items.length).toBe(text.match(/^\d+\.\s/gm)?.length);
      const formatted = formatQuestions(items);
      expect(words(formatted)).toEqual(words(text));
      // Parsing the saved format again is stable.
      expect(formatQuestions(parseQuestions(formatted))).toBe(formatted);
    }
  );

  it("treats unnumbered lines as one question each", () => {
    expect(parseQuestions("What happened?\n\n  How long?  \n")).toEqual(["What happened?", "How long?"]);
  });

  it("drops empty rows and renumbers", () => {
    expect(formatQuestions(["First", "  ", "Second\nline"])).toBe("1. First\n2. Second line");
    expect(formatQuestions([])).toBe("");
  });
});

describe("internal keys", () => {
  it("picks the next free journey key", () => {
    expect(nextJourneyKey([])).toBe("J1");
    expect(nextJourneyKey(["J1", "J2", "J4"])).toBe("J3");
  });

  it("picks letters, then S{n}, across all journeys", () => {
    expect(nextSituationKey(["A", "B", "D"])).toBe("C");
    const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
    expect(nextSituationKey(letters)).toBe("S1");
    expect(nextSituationKey([...letters, "S1"])).toBe("S2");
  });
});

describe("character counter", () => {
  it("only shows near or over the limit", () => {
    expect(showCounter(100, 2000)).toBe(false);
    expect(showCounter(1599, 2000)).toBe(false);
    expect(showCounter(1600, 2000)).toBe(true);
    expect(showCounter(2500, 2000)).toBe(true);
  });
});

describe("cleanSteps (mirrors migration 028)", () => {
  it("keeps every word and is idempotent for the demo seed", () => {
    for (const j of DEFAULT_JOURNEYS) {
      for (const c of j.clusters) {
        const seeded = c.prompts.response_pattern.find((v) => v.version === 1)!.content;
        const cleaned = cleanSteps(seeded);
        const expected = words(seeded);
        if (expected[0] === "Response" && expected[1] === "pattern:") expected.splice(0, 2);
        expect(words(cleaned)).toEqual(expected);
        expect(cleanSteps(cleaned)).toBe(cleaned);
        expect(c.prompts.response_pattern.find((v) => v.is_active)?.content).toBe(cleaned);
      }
    }
  });
});
