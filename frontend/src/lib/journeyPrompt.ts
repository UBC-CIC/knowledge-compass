import type { Journey, JourneyCluster, JourneyPromptVersion } from "@/types/journeys";

/**
 * Client-side mirror of textGeneration/helpers/journeys.py, used by the admin
 * preview to show the <journeys> block the model receives for a route. Keep
 * the selection rules and layout in sync with build_suggestion_block /
 * build_detective_block.
 */

export type PreviewRoute = {
  journey: string; // journey key, "BOTH" or "UNCLEAR"
  situation: string; // cluster key or "UNKNOWN"
  secondary: string; // cluster key or "NONE"
};

type Active = {
  key: string;
  name: string;
  description: string;
  signals: string;
  questions: string;
  guidance: string;
  clusters: Array<{ key: string; name: string; matches: string; priority: number; pattern: string }>;
};

const RULE = "=".repeat(67);

const activeContent = (versions: JourneyPromptVersion[]) =>
  versions.find((v) => v.is_active)?.content ?? "";

const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

const indent = (text: string, prefix = "  ") =>
  text
    .split("\n")
    .map((line) => (line.trim() ? `${prefix}${line}` : ""))
    .join("\n");

const bySort = <T extends { sort_order: number; key: string }>(a: T, b: T) =>
  a.sort_order - b.sort_order || a.key.localeCompare(b.key);

/** Active (non-archived) journeys and clusters, as the runtime catalog sees them. */
export function activeCatalog(journeys: Journey[]): Active[] {
  return journeys
    .filter((j) => !j.is_archived)
    .sort(bySort)
    .map((j) => ({
      key: j.key,
      name: j.name,
      description: j.description,
      signals: j.detection_signals,
      questions: activeContent(j.prompts.detective_questions),
      guidance: activeContent(j.prompts.guidance),
      clusters: j.clusters
        .filter((c: JourneyCluster) => !c.is_archived)
        .sort(bySort)
        .map((c) => ({
          key: c.key,
          name: c.name,
          matches: c.matches_when,
          priority: c.priority,
          pattern: activeContent(c.prompts.response_pattern),
        })),
    }));
}

function select(catalog: Active[], route: PreviewRoute) {
  const clusterKeys = new Set(catalog.flatMap((j) => j.clusters.map((c) => c.key)));
  const known = [route.situation, route.secondary].filter((k, i, all) => clusterKeys.has(k) && all.indexOf(k) === i);
  const routed = catalog.find((j) => j.key === route.journey);
  if (known.length === 0) {
    return routed ? [{ journey: routed, clusters: routed.clusters }] : catalog.map((j) => ({ journey: j, clusters: j.clusters }));
  }
  const selected = new Set(catalog.filter((j) => j.clusters.some((c) => known.includes(c.key))).map((j) => j.key));
  if (routed) selected.add(routed.key);
  return catalog
    .filter((j) => selected.has(j.key))
    .map((j) => ({ journey: j, clusters: j.clusters.filter((c) => known.includes(c.key)) }));
}

export function buildSuggestionBlock(journeys: Journey[], route: PreviewRoute): string {
  const selection = select(activeCatalog(journeys), route);
  if (selection.length === 0) return "";
  const included = selection.flatMap((s) => s.clusters);
  const parts: string[] = [];
  if (included.length > 1) {
    const priorities = [...new Set(included.map((c) => c.priority))].sort((a, b) => a - b);
    parts.push(
      [
        "Priority order for the situations below (1 is the most pressing):",
        ...priorities.map(
          (p) => `  ${p}. ${included.filter((c) => c.priority === p).map((c) => `${c.key} (${c.name})`).join(", ")}`
        ),
      ].join("\n")
    );
  }
  for (const { journey, clusters } of selection) {
    const section = [`${RULE}\nJOURNEY ${journey.key} — ${journey.name.toUpperCase()}\n${RULE}`];
    if (journey.guidance.trim()) section.push(journey.guidance.trim());
    for (const c of clusters) {
      let text = `SITUATION ${c.key} — ${c.name.toUpperCase()} (priority ${c.priority})`;
      if (c.matches.trim()) text += `\nMatches when: ${oneLine(c.matches)}`;
      if (c.pattern.trim()) text += `\n\n${c.pattern.trim()}`;
      section.push(text);
    }
    parts.push(section.join("\n\n"));
  }
  return `<journeys>\n${parts.join("\n\n")}\n</journeys>`;
}

export function buildDetectiveBlock(journeys: Journey[], route: PreviewRoute): string {
  const catalog = activeCatalog(journeys);
  if (catalog.length === 0) return "";
  let focus = catalog.find((j) => j.key === route.journey) ?? null;
  if (!focus && route.journey !== "BOTH") {
    const owners = catalog.filter((j) => j.clusters.some((c) => c.key === route.situation || c.key === route.secondary));
    focus = owners.length === 1 ? owners[0] : null;
  }
  const sections = catalog.map((j) => {
    const lines = [`JOURNEY ${j.key} — ${j.name}`];
    if (j.description.trim()) lines.push(indent(j.description.trim()));
    if (j.signals.trim()) lines.push("  Signals:", indent(j.signals.trim(), "    "));
    if (j.clusters.length) lines.push(`  Situations: ${j.clusters.map((c) => `${c.key} ${c.name}`).join("; ")}`);
    if ((!focus || focus.key === j.key) && j.questions.trim()) {
      lines.push("  Questions to ask (in this order if unknown):", indent(j.questions.trim(), "    "));
    }
    return lines.join("\n");
  });
  return `<journeys>\n${sections.join("\n\n")}\n</journeys>`;
}
