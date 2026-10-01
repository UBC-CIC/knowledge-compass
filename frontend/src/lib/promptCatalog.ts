import type { SystemMessageType } from "@/types/systemMessages";
import type { Journey, JourneyCluster } from "@/types/journeys";

/**
 * Plain-language labels for the admin Prompts page, ordered the way a
 * conversation uses them (textGeneration/helpers/logic.py):
 *   every reply: role -> guardrails -> language guidelines
 *   1 asking:    shared detective rules -> journeys block -> reply layout
 *   2 guiding:   shared guidance principles -> journeys block -> reply layout
 */

export type PromptStage = "every" | "asking" | "guiding" | "screen";

export const STAGE_STYLE: Record<PromptStage, { label: string; bg: string; fg: string }> = {
  every: { label: "Every reply", bg: "oklch(0.96 0.02 268)", fg: "oklch(0.42 0.10 268)" },
  asking: { label: "1 · Asking questions", bg: "oklch(0.96 0.03 230)", fg: "oklch(0.42 0.11 230)" },
  guiding: { label: "2 · Giving guidance", bg: "oklch(0.95 0.04 160)", fg: "oklch(0.36 0.09 160)" },
  screen: { label: "Shown on screen", bg: "rgba(22,24,29,0.06)", fg: "rgba(22,24,29,0.72)" },
};

export type GeneralPrompt = {
  id: SystemMessageType;
  name: string;
  sub: string;
  stage: PromptStage;
  explain: string;
  technical?: boolean;
};

export const GENERAL_PROMPTS: GeneralPrompt[] = [
  {
    id: "system_role",
    name: "Who the assistant is",
    sub: "Its role and the families it serves",
    stage: "every",
    explain: "The opening description of the assistant. Sent at the top of every reply, in both steps.",
  },
  {
    id: "guardrails",
    name: "Boundaries",
    sub: "What it must never and always do",
    stage: "every",
    explain: "Rules the assistant must always follow, such as never giving legal advice. Sent with every reply, in both steps.",
  },
  {
    id: "language_guidelines",
    name: "Preferred language",
    sub: "Inclusion Canada's word choices",
    stage: "every",
    explain: "Inclusion Canada's preferred words. Sent with every reply, in both steps.",
  },
  {
    id: "detective_phase_prompt",
    name: "How to ask questions",
    sub: "Shared rules for every journey",
    stage: "asking",
    explain:
      "Rules shared by every journey while the assistant is asking questions. Each journey's own words and questions are added after this. Keep {exchange_count} and {readiness_note} as they are; the app fills them in.",
  },
  {
    id: "output_format_detective",
    name: "Reply layout while asking",
    sub: "A short acknowledgement and one question",
    stage: "asking",
    technical: true,
    explain: "Shapes question replies: a short acknowledgement and a single question.",
  },
  {
    id: "suggestion_phase_prompt",
    name: "How to give guidance",
    sub: "Shared principles for every journey",
    stage: "guiding",
    explain:
      "Principles shared by every guidance reply. The journey's guidance and the situation's steps are added after this.",
  },
  {
    id: "output_format_suggestion",
    name: "Reply layout for guidance",
    sub: "Structure of a full answer and its sources",
    stage: "guiding",
    technical: true,
    explain: "Shapes full guidance replies and how sources are listed.",
  },
  {
    id: "output_format_partial",
    name: "Reply layout when one detail is missing",
    sub: "One or two first steps plus a question",
    stage: "guiding",
    technical: true,
    explain:
      "Used instead of the guidance layout when the situation is mostly clear but one detail is missing (dynamic routing only).",
  },
  {
    id: "welcome_message",
    name: "Welcome message",
    sub: "The first thing families read",
    stage: "screen",
    explain: "The first message a family sees when they open the guide. Not sent to the assistant.",
  },
  {
    id: "disclaimer",
    name: "Disclaimer",
    sub: "The limits of the guide",
    stage: "screen",
    explain: "Shown under the conversation. Explains the limits of the guide. Not sent to the assistant.",
  },
];

export const TECH_NOTE =
  "The app reads the tags in this text (such as <answer>, <cited_indices>, <journey_state> and <detective_state>) to show replies and sources. Change the wording around them, but keep every tag exactly as written.";

/** Situation urgency. Stored as journey_clusters.priority (1 = most pressing). */
export const URGENCY_LEVELS = [1, 2, 3, 4, 5] as const;
export const URGENCY_LABELS: Record<number, string> = {
  1: "Happening now",
  2: "Needs action soon",
  3: "Active issue",
  4: "Understanding",
  5: "Planning ahead",
};
export const urgencyLabel = (n: number) => URGENCY_LABELS[n] ?? `Level ${n}`;

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

export function firstLines(text: string, n: number): string {
  const lines = (text ?? "").split("\n").filter((l) => l.trim());
  return lines.slice(0, n).map((l) => l.trim()).join("\n") + (lines.length > n ? "\n…" : "");
}

/** "80% positive" from thumbs counts, or "" when nothing is rated. */
export function positiveShare(count?: { up: number; down: number }): string {
  if (!count || count.up + count.down === 0) return "";
  return `${Math.round((count.up / (count.up + count.down)) * 100)}% positive`;
}

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
