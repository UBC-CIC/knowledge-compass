import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLOW_PRESETS,
  RECOMMENDED,
  changedSettings,
  flowPresetFor,
  fromApi,
  validateSettings,
} from "@/lib/assistantSettings";

const repo = resolve(__dirname, "../../..");

describe("flow presets", () => {
  it("recognises each preset from its own values", () => {
    for (const p of FLOW_PRESETS) expect(flowPresetFor({ ...RECOMMENDED, ...p.values })).toBe(p.id);
  });

  it("the recommended settings use the first preset", () => {
    expect(flowPresetFor(RECOMMENDED)).toBe("ask_first");
  });

  it("ignores the floor in fixed mode and reports custom combinations", () => {
    expect(flowPresetFor({ ...RECOMMENDED, min_exchanges_before_answer: 3 })).toBe("ask_first");
    expect(flowPresetFor({ ...RECOMMENDED, routing_mode: "dynamic", min_exchanges_before_answer: 2, min_messages_before_suggest: 6 })).toBeNull();
  });

  it("every preset passes validation", () => {
    for (const p of FLOW_PRESETS) expect(validateSettings({ ...RECOMMENDED, ...p.values })).toEqual({});
  });
});

describe("validation", () => {
  it("mirrors the API ranges", () => {
    const errors = validateSettings({ ...RECOMMENDED, max_messages_per_day: 0, support_score_threshold: Number.NaN, max_characters_per_user_message: 1.5, max_characters_per_day: 0 });
    expect(Object.keys(errors).sort()).toEqual(["max_characters_per_day", "max_characters_per_user_message", "max_messages_per_day", "support_score_threshold"]);
  });

  it("checks the floor against the ceiling in dynamic mode only", () => {
    const s = { ...RECOMMENDED, min_exchanges_before_answer: 5, min_messages_before_suggest: 3 };
    expect(validateSettings({ ...s, routing_mode: "dynamic" }).min_exchanges_before_answer).toBeTruthy();
    expect(validateSettings({ ...s, routing_mode: "fixed" })).toEqual({});
  });
});

describe("API helpers", () => {
  it("sends only changed fields", () => {
    expect(changedSettings(RECOMMENDED, { ...RECOMMENDED, grounded_threshold: 0.6, routing_mode: "dynamic" })).toEqual({ grounded_threshold: 0.6, routing_mode: "dynamic" });
    expect(changedSettings(RECOMMENDED, RECOMMENDED)).toEqual({});
  });

  it("fills missing or bad values with the recommended ones", () => {
    const s = fromApi({ support_score_threshold: "0.3", grounded_threshold: null, routing_mode: "weird", max_messages_per_day: 10 });
    expect(s.support_score_threshold).toBe(0.3);
    expect(s.grounded_threshold).toBe(RECOMMENDED.grounded_threshold);
    expect(s.routing_mode).toBe("fixed");
    expect(s.max_messages_per_day).toBe(10);
  });
});

describe("recommended values stay in sync with the backend", () => {
  it("matches helpers/config.py", () => {
    const py = readFileSync(resolve(repo, "cdk/lambda/textGeneration/helpers/config.py"), "utf8");
    const num = (name: string) => Number(py.match(new RegExp(`^${name} = ([\\d.]+)`, "m"))?.[1]);
    expect(num("MAX_MESSAGES_PER_DAY")).toBe(RECOMMENDED.max_messages_per_day);
    expect(num("MIN_EXCHANGES_BEFORE_SUGGEST")).toBe(RECOMMENDED.min_messages_before_suggest);
    expect(num("MIN_EXCHANGES_BEFORE_ANSWER")).toBe(RECOMMENDED.min_exchanges_before_answer);
    expect(num("MAX_CHARACTERS_PER_USER_MESSAGE")).toBe(RECOMMENDED.max_characters_per_user_message);
    expect(num("MAX_CHARACTERS_PER_DAY")).toBe(RECOMMENDED.max_characters_per_day);
    expect(num("MAX_CHARACTERS_PER_AI_MESSAGE")).toBe(RECOMMENDED.max_characters_per_ai_message);
    expect(num("SUPPORT_SCORE_THRESHOLD")).toBe(RECOMMENDED.support_score_threshold);
    expect(num("SCOPE_ALIGNMENT_SCORE_THRESHOLD")).toBe(RECOMMENDED.scope_alignment_score_threshold);
    expect(num("GROUNDED_THRESHOLD")).toBe(RECOMMENDED.grounded_threshold);
    expect(num("PARTIALLY_GROUNDED_THRESHOLD")).toBe(RECOMMENDED.partially_grounded_threshold);
    expect(py).toMatch(new RegExp(`^ROUTING_MODE = "${RECOMMENDED.routing_mode}"`, "m"));
  });

  it("uses 2000 as the missed-load cap everywhere a request can miss the database", () => {
    const cap = RECOMMENDED.max_characters_per_user_message;
    const read = (rel: string) => readFileSync(resolve(repo, rel), "utf8");
    expect(read("cdk/lambda/handlers/systemMessagesHandler.js")).toContain(
      `const DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE = ${cap};`
    );
    expect(read("cdk/lambda/websocket/messageLimit.js")).toContain(
      `const DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE = ${cap};`
    );
    expect(read("frontend/src/pages/ChatInterface/ChatInterface.tsx")).toContain(
      `const DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE = ${cap};`
    );
    expect(read("frontend/src/components/ChatInterface/userInput.tsx")).toContain(`maxLength = ${cap},`);
  });

  it("matches the GET fallback in adminHandler.js", () => {
    const js = readFileSync(resolve(repo, "cdk/lambda/handlers/adminHandler.js"), "utf8");
    const block = js.slice(js.indexOf("const fallback = {"), js.indexOf("};", js.indexOf("const fallback = {")));
    for (const [key, value] of Object.entries(RECOMMENDED)) {
      expect(block).toContain(`${key}: ${typeof value === "string" ? `"${value}"` : value},`);
    }
  });
});
