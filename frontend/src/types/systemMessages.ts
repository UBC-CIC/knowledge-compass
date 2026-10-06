import type { PromptVersion } from "@/lib/promptVersions";

/**
 * Editable system_messages types. Must match SYSTEM_MESSAGE_TYPES in
 * cdk/lambda/handlers/adminHandler.js.
 */
export type SystemMessageType =
  | "system_role"
  | "guardrails"
  | "language_guidelines"
  | "detective_phase_prompt"
  | "suggestion_phase_prompt"
  | "output_format_detective"
  | "output_format_suggestion"
  | "output_format_partial"
  | "welcome_message"
  | "disclaimer";

export type SystemMessageVersion = PromptVersion & {
  type: SystemMessageType;
  affects_text_generation: boolean;
};

export type SystemMessages = Partial<Record<SystemMessageType, SystemMessageVersion[]>>;
