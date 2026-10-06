import type { SystemMessageType } from "@/types/systemMessages";
import type { Journey, JourneyCluster } from "@/types/journeys";

/**
 * Plain-language structure of the admin Prompts page. The order follows how a
 * conversation uses each text (textGeneration/helpers/logic.py):
 *   every reply: role (+ journey list) -> guardrails -> language guidelines
 *   1 asking:    shared detective rules -> every journey's words and questions
 *   2 guiding:   shared guidance rules -> journey guidance -> situation steps
 */

export type PromptStage = "every" | "asking" | "guiding";

export const STAGE_STYLE: Record<PromptStage, { label: string; bg: string; fg: string }> = {
  every: { label: "Every reply", bg: "oklch(0.96 0.02 268)", fg: "oklch(0.42 0.10 268)" },
  asking: { label: "1 · Asking questions", bg: "oklch(0.96 0.03 230)", fg: "oklch(0.42 0.11 230)" },
  guiding: { label: "2 · Giving guidance", bg: "oklch(0.95 0.04 160)", fg: "oklch(0.36 0.09 160)" },
};

/** Green "safety net" colours. */
export const SAFETY = { bg: "oklch(0.97 0.02 160)", border: "oklch(0.70 0.08 160)", fg: "oklch(0.30 0.06 160)" };

/** Shared pages in the left navigation. */
export type SharedPageId = "assistant" | "talks" | "screen" | "advanced";

export type SharedSection = {
  id: SystemMessageType;
  title: string;
  stage?: Exclude<PromptStage, "every">;
  /** Dashed pill under the text: what the app adds automatically. */
  autoInsert?: string;
};

export type SharedPage = {
  id: SharedPageId;
  name: string;
  sub: string;
  explain: string;
  sections: SharedSection[];
  /** Reply layouts: monospace, shown with TECH_NOTE. */
  technical?: boolean;
};

export const TECH_NOTE =
  "The app reads the tags in this text (such as <answer>, <cited_indices>, <journey_state> and <detective_state>) to show replies and sources. Change the wording around them, but keep every tag exactly as written.";

export const SHARED_PAGES: Record<SharedPageId, SharedPage> = {
  assistant: {
    id: "assistant",
    name: "The assistant",
    sub: "Who it is · boundaries · preferred language",
    explain: "Who the assistant is and the rules it always follows. Sent with every reply, for every journey.",
    sections: [
      { id: "system_role", title: "Who it is", autoInsert: "Journey list added here automatically" },
      { id: "guardrails", title: "Boundaries" },
      { id: "language_guidelines", title: "Preferred language" },
    ],
  },
  talks: {
    id: "talks",
    name: "How it talks",
    sub: "Asking questions · giving guidance",
    explain:
      "How the assistant runs a conversation, for every journey. Each journey adds its own questions and guidance on top, automatically.",
    sections: [
      {
        id: "detective_phase_prompt",
        title: "Asking questions",
        stage: "asking",
        autoInsert: "The conversation's progress and every journey's description, words and questions added automatically",
      },
      {
        id: "suggestion_phase_prompt",
        title: "Giving guidance",
        stage: "guiding",
        autoInsert: "The journey's guidance and matching situation steps added automatically",
      },
    ],
  },
  screen: {
    id: "screen",
    name: "Welcome and disclaimer",
    sub: "What families read in the app",
    explain: "Families see these on screen. They are not sent to the assistant.",
    sections: [
      { id: "welcome_message", title: "Welcome message" },
      { id: "disclaimer", title: "Disclaimer" },
    ],
  },
  advanced: {
    id: "advanced",
    name: "Reply layouts",
    sub: "Tags the app reads. Edit with care.",
    explain:
      "The format the app expects replies in. Changes here can break how replies and sources are shown, so leave these to a developer.",
    technical: true,
    sections: [
      { id: "output_format_detective", title: "While asking" },
      { id: "output_format_suggestion", title: "Full guidance" },
      { id: "output_format_partial", title: "Guidance with one detail missing" },
    ],
  },
};

/** One line under the page title, in place of a diagram of the conversation steps. */
export const STAGE_SUMMARY =
  "Every reply uses The assistant. Asking questions and giving guidance add How it talks, plus the journey's own text.";

/**
 * Notes shown while the live text is still the cleaned-up version published
 * by a migration (025 system_role, 027 How it talks) and an older version
 * exists to go back to. The shipped text is in defaultSystemMessages.ts.
 */
export const CLEANUP_NOTES: Partial<Record<SystemMessageType, string>> = {
  system_role:
    "Cleaned up: the hard-coded Journey 1 and Journey 2 descriptions were removed. The journey list is now added automatically.",
  detective_phase_prompt: "Cleaned up: app instructions are now added automatically.",
  suggestion_phase_prompt: "Cleaned up: app instructions are now added automatically.",
};


export const bySortOrder = <T extends { sort_order: number; key: string }>(a: T, b: T) =>
  a.sort_order - b.sort_order || a.key.localeCompare(b.key);

export const activeClusters = (journey: Journey): JourneyCluster[] =>
  journey.clusters.filter((c) => !c.is_archived).sort(bySortOrder);

/** "sent home," "reduced schedule," … -> ["sent home", "reduced schedule"] */
export function signalChips(text: string): string[] {
  const quoted = [...(text ?? "").matchAll(/"([^"]+?)"/g)].map((m) => m[1].replace(/,\s*$/, "").trim());
  if (quoted.length) return quoted.filter(Boolean);
  return (text ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** "sent home, reduced schedule" -> "sent home," "reduced schedule" (the seeded format). */
export function signalsFromWords(words: string): string {
  const phrases = words
    .split(/[,\n]/)
    .map((s) => s.replace(/"/g, "").trim())
    .filter(Boolean);
  return phrases.map((p, i) => `"${p}${i < phrases.length - 1 ? "," : ""}"`).join(" ");
}

/** Normalised comparison so re-spacing the list does not count as a change. */
export const wordsKey = (words: string) =>
  words
    .split(/[,\n]/)
    .map((s) => s.replace(/"/g, "").trim())
    .filter(Boolean)
    .join("|");

export type SituationLayer = {
  mode: "matched" | "journey-fallback" | "all-fallback";
  clusters: JourneyCluster[];
};

/**
 * Which situation steps a guidance reply receives (mirrors
 * journeys.select_for_route): the picked situation, otherwise every situation
 * in the journey, otherwise every situation in every journey.
 */
export function situationLayer(journeys: Journey[], journeyKey: string, situationKey: string): SituationLayer {
  const live = journeys.filter((j) => !j.is_archived);
  const all = live.flatMap(activeClusters);
  const picked = all.find((c) => c.key === situationKey);
  if (picked) return { mode: "matched", clusters: [picked] };
  const journey = live.find((j) => j.key === journeyKey);
  if (journey) return { mode: "journey-fallback", clusters: activeClusters(journey) };
  return { mode: "all-fallback", clusters: all };
}

/** Next free J{n} key for a new journey (keys are internal, never shown). */
export function nextJourneyKey(taken: string[]): string {
  let n = 1;
  while (taken.includes(`J${n}`)) n += 1;
  return `J${n}`;
}

/** Next free situation key: A–Z, then S1, S2, … (unique across all journeys). */
export function nextSituationKey(taken: string[]): string {
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!taken.includes(ch)) return ch;
  let n = 1;
  while (taken.includes(`S${n}`)) n += 1;
  return `S${n}`;
}

/** Counters only appear when a text is near (80%) or over its limit. */
export const showCounter = (length: number, limit: number) => length >= limit * 0.8;

const STEP_ITEM = /^(\d+\.|[-*•])\s/;

/**
 * Formatting-only cleanup of seeded situation steps. Mirrors cleanSteps in
 * migration 028 (used for the demo data): drops a leading "Response pattern:"
 * line and joins hard-wrapped lines. No words change; idempotent.
 */
export function cleanSteps(text: string): string {
  let lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[0].trim() === "Response pattern:") lines = lines.slice(1);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (!t) {
      out.push("");
      continue;
    }
    const prev = out.length ? out[out.length - 1] : "";
    const continues = prev !== "" && !STEP_ITEM.test(t) && (/^\s/.test(line) || !prev.endsWith(":"));
    if (continues) out[out.length - 1] = `${prev} ${t}`;
    else out.push(t);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * "1. First\n   wrapped\n2. Second" -> ["First wrapped", "Second"].
 * Unnumbered text: each non-blank line is one question.
 */
export function parseQuestions(text: string): string[] {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const numbered = /^\s*\d+[.)]\s+/;
  if (!lines.some((l) => numbered.test(l))) return lines.map((l) => l.trim()).filter(Boolean);
  const items: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (numbered.test(line)) items.push(t.replace(/^\d+[.)]\s+/, ""));
    else if (items.length) items[items.length - 1] += ` ${t}`;
    else items.push(t);
  }
  return items;
}

/** ["First", "", "Second"] -> "1. First\n2. Second" (empty rows dropped). */
export function formatQuestions(items: string[]): string {
  return items
    .map((q) => q.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");
}
