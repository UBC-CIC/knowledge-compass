/**
 * Assistant settings (GET/PUT /admin/system-settings) in plain language.
 *
 * RECOMMENDED matches the runtime fallbacks in
 * cdk/lambda/textGeneration/helpers/config.py, the GET fallback in
 * cdk/lambda/handlers/adminHandler.js, and the missed-load default for
 * max_characters_per_user_message on the public read route, the WebSocket
 * frame cap, and the chat composer. Keep them in sync.
 */

export type RoutingMode = "fixed" | "dynamic";

export type AssistantSettings = {
  max_messages_per_day: number;
  min_messages_before_suggest: number;
  routing_mode: RoutingMode;
  min_exchanges_before_answer: number;
  max_characters_per_user_message: number;
  max_characters_per_day: number;
  max_messages_per_day_global: number;
  max_characters_per_ai_message: number;
  support_score_threshold: number;
  scope_alignment_score_threshold: number;
  grounded_threshold: number;
  partially_grounded_threshold: number;
};

export type SettingKey = keyof AssistantSettings;

export const RECOMMENDED: AssistantSettings = {
  max_messages_per_day: 45,
  min_messages_before_suggest: 4,
  routing_mode: "fixed",
  min_exchanges_before_answer: 0,
  max_characters_per_user_message: 2000,
  max_characters_per_day: 10000,
  max_messages_per_day_global: 5000,
  max_characters_per_ai_message: 5000,
  support_score_threshold: 0.25,
  scope_alignment_score_threshold: 0.25,
  grounded_threshold: 0.75,
  partially_grounded_threshold: 0.5,
};

export const SETTING_KEYS = Object.keys(RECOMMENDED) as SettingKey[];

/** Settings a developer manages; "Reset to recommended" only touches these. */
export const DEVELOPER_KEYS: SettingKey[] = [
  "max_characters_per_ai_message",
  "support_score_threshold",
  "scope_alignment_score_threshold",
  "grounded_threshold",
  "partially_grounded_threshold",
];

// ------------------------------------------------------------------
// Conversation flow presets
// ------------------------------------------------------------------

export type FlowPresetId = "ask_first" | "balanced" | "answer_when_clear";

type FlowValues = Pick<AssistantSettings, "routing_mode" | "min_exchanges_before_answer" | "min_messages_before_suggest">;

export const FLOW_PRESETS: Array<{ id: FlowPresetId; title: string; body: string; values: FlowValues }> = [
  {
    id: "ask_first",
    title: "Ask a few questions first",
    body: "The assistant asks questions for the first 4 messages, then gives guidance.",
    values: { routing_mode: "fixed", min_exchanges_before_answer: 0, min_messages_before_suggest: 4 },
  },
  {
    id: "balanced",
    title: "Balanced",
    body: "Asks at least one question, then gives guidance once the situation is clear, and by the 3rd message at the latest.",
    values: { routing_mode: "dynamic", min_exchanges_before_answer: 1, min_messages_before_suggest: 3 },
  },
  {
    id: "answer_when_clear",
    title: "Answer as soon as it's clear",
    body: "Gives guidance as soon as the situation is clear, even on the first message, and by the 4th message at the latest.",
    values: { routing_mode: "dynamic", min_exchanges_before_answer: 0, min_messages_before_suggest: 4 },
  },
];

export const URGENT_NOTE = "Urgent situations, such as a school asking a family to pick up their child now, are always answered right away.";

/** The preset the saved values match, or null for a custom combination. */
export function flowPresetFor(s: FlowValues): FlowPresetId | null {
  const match = FLOW_PRESETS.find((p) => {
    const v = p.values;
    if (s.routing_mode !== v.routing_mode || s.min_messages_before_suggest !== v.min_messages_before_suggest) return false;
    // The floor is only used in dynamic mode.
    return s.routing_mode === "fixed" || s.min_exchanges_before_answer === v.min_exchanges_before_answer;
  });
  return match?.id ?? null;
}

// ------------------------------------------------------------------
// Validation (mirrors PUT /admin/system-settings in adminHandler.js)
// ------------------------------------------------------------------

type Rule = { min: number; max: number; integer: boolean; label: string };

const RULES: Partial<Record<SettingKey, Rule>> = {
  max_messages_per_day: { min: 1, max: 1000, integer: true, label: "Messages per day" },
  min_messages_before_suggest: { min: 0, max: 500, integer: true, label: "Give guidance by message" },
  min_exchanges_before_answer: { min: 0, max: 500, integer: true, label: "Questions before guidance" },
  max_characters_per_user_message: { min: 1, max: 200000, integer: true, label: "Longest message" },
  max_characters_per_day: { min: 1, max: 1000000, integer: true, label: "Characters per day" },
  max_messages_per_day_global: { min: 1, max: 1000000, integer: true, label: "Messages per day, everyone" },
  max_characters_per_ai_message: { min: 1, max: 200000, integer: true, label: "Longest reply" },
  support_score_threshold: { min: 0, max: 1, integer: false, label: "Evidence match" },
  scope_alignment_score_threshold: { min: 0, max: 1, integer: false, label: "Topic match" },
  grounded_threshold: { min: 0, max: 1, integer: false, label: "Reliable answer" },
  partially_grounded_threshold: { min: 0, max: 1, integer: false, label: "Partial warning" },
};

/** Field -> problem, for every value the API would reject. */
export function validateSettings(s: AssistantSettings): Partial<Record<SettingKey, string>> {
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const [key, rule] of Object.entries(RULES) as Array<[SettingKey, Rule]>) {
    const v = s[key] as number;
    if (!Number.isFinite(v) || v < rule.min || v > rule.max || (rule.integer && !Number.isInteger(v))) {
      errors[key] = `Use ${rule.integer ? "a whole number" : "a number"} from ${rule.min} to ${rule.max.toLocaleString()}.`;
    }
  }
  if (
    s.routing_mode === "dynamic" &&
    !errors.min_exchanges_before_answer &&
    !errors.min_messages_before_suggest &&
    s.min_exchanges_before_answer > s.min_messages_before_suggest
  ) {
    errors.min_exchanges_before_answer = "Can't be more than the message guidance is given by.";
  }
  return errors;
}

/** Only the fields that differ from `saved` (PUT is patch-style). */
export function changedSettings(saved: AssistantSettings, draft: AssistantSettings): Partial<AssistantSettings> {
  const patch: Partial<AssistantSettings> = {};
  for (const key of SETTING_KEYS) {
    if (draft[key] !== saved[key]) (patch as Record<string, unknown>)[key] = draft[key];
  }
  return patch;
}

/** API response -> settings, keeping recommended values for anything missing. */
export function fromApi(data: Partial<Record<SettingKey, unknown>>): AssistantSettings {
  const out = { ...RECOMMENDED };
  for (const key of SETTING_KEYS) {
    const v = data[key];
    if (key === "routing_mode") {
      if (v === "fixed" || v === "dynamic") out.routing_mode = v;
    } else if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
      (out as Record<string, unknown>)[key] = Number(v);
    }
  }
  return out;
}
