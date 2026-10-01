import type { PromptVersion } from "@/lib/promptVersions";

/**
 * Journeys and situation clusters managed from the admin Journeys tab.
 * Shapes match GET /admin/journeys (cdk/lambda/handlers/utils/journeyPrompts.js).
 */

export type JourneyPromptField = "detective_questions" | "guidance" | "response_pattern";

export type JourneyPromptVersion = PromptVersion & {
  field: JourneyPromptField;
  owner_id: string;
};

export type JourneyCluster = {
  id: string;
  journey_id: string;
  key: string;
  name: string;
  matches_when: string;
  priority: number;
  sort_order: number;
  is_archived: boolean;
  updated_at?: string;
  updated_by_email?: string | null;
  prompts: { response_pattern: JourneyPromptVersion[] };
};

export type Journey = {
  id: string;
  key: string;
  name: string;
  description: string;
  detection_signals: string;
  sort_order: number;
  is_archived: boolean;
  updated_at?: string;
  updated_by_email?: string | null;
  prompts: {
    detective_questions: JourneyPromptVersion[];
    guidance: JourneyPromptVersion[];
  };
  clusters: JourneyCluster[];
};

export type JourneyInput = {
  key: string;
  name: string;
  description?: string;
  detection_signals?: string;
  sort_order?: number;
  detective_questions?: string;
  guidance?: string;
};

export type JourneyPatch = Partial<
  Pick<Journey, "name" | "description" | "detection_signals" | "sort_order" | "is_archived">
>;

export type ClusterInput = {
  key: string;
  name: string;
  matches_when: string;
  priority?: number;
  sort_order?: number;
  response_pattern?: string;
};

export type ClusterPatch = Partial<
  Pick<JourneyCluster, "name" | "matches_when" | "priority" | "sort_order" | "is_archived">
>;

export type FeedbackCount = {
  key: string;
  name: string;
  is_archived: boolean;
  up: number;
  down: number;
  sessions: number;
};

export type JourneyFeedback = {
  days: number | null;
  journeys: FeedbackCount[];
  clusters: Array<FeedbackCount & { journey_key: string | null }>;
  untagged: { up: number; down: number; sessions: number };
};

// Keep in sync with KEY_PATTERN / RESERVED_KEYS in journeyPrompts.js and
// textGeneration/helpers/journeys.py.
export const KEY_PATTERN = /^[A-Z0-9_]{1,16}$/;
export const RESERVED_KEYS = ["BOTH", "UNCLEAR", "UNKNOWN", "NONE"];
export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 5;

export const DEFAULT_PROMPT_LIMITS: Record<JourneyPromptField, number> = {
  detective_questions: 4000,
  guidance: 6000,
  response_pattern: 6000,
};

export function keyError(key: string, taken: string[]): string | null {
  if (!key) return "Enter a key.";
  if (!KEY_PATTERN.test(key)) {
    return "Use 1-16 upper-case letters, digits or underscores (for example J3 or P).";
  }
  if (RESERVED_KEYS.includes(key)) return `${key} is reserved. Choose another key.`;
  if (taken.includes(key)) return `${key} is already used.`;
  return null;
}
