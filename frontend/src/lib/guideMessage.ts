/**
 * Notebook-style guide replies:
 *   Detective  — acknowledgement + one question (plain markdown)
 *   Suggestion — <answer> body with a plan; sources listed separately
 */

const XML_TAGS = /<\/?answer>|<\/?cited_indices>[\s\S]*$/gi;

export function displayGuideText(text: string): string {
  return text.replace(XML_TAGS, "").trim();
}

export function isSuggestionPhase(
  phase?: string | null,
  sources?: unknown[],
  text?: string
): boolean {
  if (phase === "SUGGESTION") return true;
  if (phase === "DETECTIVE") return false;
  if (sources && sources.length > 0) return true;
  return Boolean(text && /here's what to do/i.test(text));
}
