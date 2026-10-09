import type { SourceItem } from "@/types/Chat";

export const isSafeUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};

export const PREVIEW_MAX_CHARS = 320;

export function truncatePreview(text: string) {
  const clean = text.trim();
  if (clean.length <= PREVIEW_MAX_CHARS) return clean;
  return `${clean.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`;
}

export function sourceLabel(source: SourceItem | string) {
  if (typeof source === "string") {
    const urlMatch = source.match(/(https?:\/\/[^\s]+)/);
    return {
      title: source.replace(urlMatch?.[0] ?? "", "").trim() || source,
      url: urlMatch?.[0] ?? "",
      type: "",
      preview: "",
    };
  }
  const url = source.url || source.uri || "";
  const title = source.title || url || "Source";
  const type = (source.source_type || source.type || "").toLowerCase();
  const preview = source.content ? truncatePreview(source.content) : "";
  return { title, url, type, preview };
}

export function isHttpSource(source: SourceItem | string) {
  const { url } = sourceLabel(source);
  return isSafeUrl(url);
}

// Uploaded documents and CSV row resources still get cards without public
// URLs. Guideline-mode guide sections are never shown: the server already
// drops them, and this is a fallback in case one ever arrives.
export function isResourceSource(source: SourceItem | string) {
  const type = sourceLabel(source).type;
  if (type === "guideline") return false;
  return isHttpSource(source) || type === "document" || type === "csv_row";
}
