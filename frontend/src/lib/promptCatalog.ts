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

/** Navigation groups that the stage cards can highlight. */
export type NavGroup = SharedPageId | "journeys";

export type SharedSection = {
  id: SystemMessageType;
  title: string;
  stage?: Exclude<PromptStage, "every">;
  /** Dashed pill under the text: what the app adds automatically. */
  autoInsert?: string;
  /** Amber note above the text. */
  warning?: string;
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
        autoInsert: "Every journey's description, words and questions added here automatically",
        warning: "Keep the words in {curly brackets}. The app fills them in with the conversation's progress.",
      },
      {
        id: "suggestion_phase_prompt",
        title: "Giving guidance",
        stage: "guiding",
        autoInsert: "The journey's guidance and matching situation steps added here automatically",
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

/** Stage cards above the editor. Clicking one dims the nav groups it doesn't use. */
export const STAGE_CARDS: Array<{ k: PromptStage; num: string; title: string; body: string; uses: NavGroup[] }> = [
  {
    k: "every",
    num: "",
    title: "Every reply",
    body: "“The assistant”: who it is, its boundaries and preferred language.",
    uses: ["assistant"],
  },
  {
    k: "asking",
    num: "1",
    title: "Asking questions",
    body: "“How it talks” + the journey's questions. One at a time, to find where the family is.",
    uses: ["talks", "journeys"],
  },
  {
    k: "guiding",
    num: "2",
    title: "Giving guidance",
    body: "“How it talks” + the journey's guidance + the steps for the situations that fit.",
    uses: ["talks", "journeys"],
  },
];

/**
 * Notes shown when the active version is the journey-neutral text published
 * by a migration (025 for system_role), with an older version to go back to.
 */
export const CLEANUPS: Partial<Record<SystemMessageType, { content: string; note: string }>> = {
  system_role: {
    content:
      "You are a compassionate, knowledgeable guide helping families navigate inclusive education in Canada, built for Inclusion Canada. You serve parents, support persons, and family members.\n\nThe journeys you support are listed below. Use them to understand where each family is.\n\nYour role is to help families understand their situation, take clear next steps, and find the right resources. You do not provide legal advice or make decisions for them.",
    note: "Cleaned up: the hard-coded Journey 1 and Journey 2 descriptions were removed. The journey list is now added automatically.",
  },
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

export type SituationLayer =
  | { mode: "matched"; clusters: JourneyCluster[]; text: string }
  | { mode: "journey-fallback"; clusters: JourneyCluster[]; text: string }
  | { mode: "all-fallback"; clusters: JourneyCluster[]; text: string };

/**
 * Which situation steps a guidance reply receives (mirrors
 * journeys.select_for_route): the picked situation, otherwise every situation
 * in the journey, otherwise every situation in every journey.
 */
export function situationLayer(journeys: Journey[], journeyKey: string, situationKey: string): SituationLayer {
  const live = journeys.filter((j) => !j.is_archived);
  const all = live.flatMap(activeClusters);
  const picked = all.find((c) => c.key === situationKey);
  if (picked) return { mode: "matched", clusters: [picked], text: `${picked.key} · ${picked.name} only` };
  const journey = live.find((j) => j.key === journeyKey);
  if (journey) {
    const cs = activeClusters(journey);
    return {
      mode: "journey-fallback",
      clusters: cs,
      text: cs.length ? `All ${cs.length} situations in ${journey.key}` : `${journey.key} has no situations yet`,
    };
  }
  return { mode: "all-fallback", clusters: all, text: `All ${all.length} situations in every journey` };
}

/** Next free J{n} key for a new journey. */
export function nextJourneyKey(taken: string[]): string {
  let n = 1;
  while (taken.includes(`J${n}`)) n += 1;
  return `J${n}`;
}
