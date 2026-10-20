/**
 * Guideline mode (migration 031): types and pure helpers shared by
 * hooks/useGuideline.ts and components/Admin/Guideline/GuidelineMode.tsx.
 * Limits mirror cdk/lambda/knowledgeBase/helpers/guideline_admin.py.
 */

export type GuidelineMode = "standard" | "guideline";
export type GuidelineStatus = "processing" | "ready" | "failed";

export type GuidelineSection = {
  id: string;
  section_key: string;
  heading_path: string | null;
  auto_label: string;
  label_override: string | null;
  label: string;
  summary: string | null;
};

export type GuidelineDocument = {
  id: string;
  file_name: string;
  status: GuidelineStatus;
  error: string | null;
  section_count: number;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  journey_id: string | null;
  sections: GuidelineSection[];
};

export type GuidelineState = {
  mode: GuidelineMode;
  mode_updated_by: string | null;
  mode_updated_at: string | null;
  documents: GuidelineDocument[];
};

export type GuideFileKind = "markdown" | "docx" | "pdf";

const MB = 1024 * 1024;

/** Per-type upload settings; mirror _FILE_TYPES in guideline_admin.py. */
export const GUIDE_FILE_TYPES: Record<GuideFileKind, { contentType: string; maxBytes: number; label: string }> = {
  markdown: { contentType: "text/markdown", maxBytes: 1 * MB, label: "1 MB" },
  docx: {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    maxBytes: 10 * MB,
    label: "10 MB",
  },
  pdf: { contentType: "application/pdf", maxBytes: 10 * MB, label: "10 MB" },
};

export const MAX_LABEL_CHARS = 80;
export const GUIDE_ACCEPT =
  ".md,.markdown,.docx,.pdf,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Last heading segment, matching the server's situation identity. */
export function situationName(heading: string | null | undefined, sectionKey = ""): string {
  let text = (heading || sectionKey || "").trim();
  const parts = text.split(" > ");
  if (parts.length > 1) text = parts[parts.length - 1] ?? text;
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Situation names covered by ready documents. Processing and failed files do not count. */
export function coveredSituationNames(documents: GuidelineDocument[]): Set<string> {
  const names = new Set<string>();
  for (const doc of documents) {
    if (doc.status !== "ready") continue;
    for (const section of doc.sections) {
      const name = situationName(section.heading_path, section.section_key);
      if (name) names.add(name);
    }
  }
  return names;
}

export function guideFileKind(name: string): GuideFileKind | null {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}

/** Plain-language problem with a chosen file, or null when it can be uploaded. */
export function validateGuideFile(file: { name: string; size: number }): string | null {
  const kind = guideFileKind(file.name);
  if (!kind) {
    return `"${file.name}" can't be used. Please choose a Markdown (.md), Word (.docx) or PDF (.pdf) file.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  const { maxBytes, label } = GUIDE_FILE_TYPES[kind];
  if (file.size > maxBytes) {
    return `"${file.name}" is larger than ${label}. Please split it into smaller files.`;
  }
  return null;
}

/** Trimmed label with inner whitespace collapsed (what the API stores). */
export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim();
}

/** Problem with a new situation name, or null. An empty name resets to the detected one. */
export function validateLabel(label: string): string | null {
  if (normalizeLabel(label).length > MAX_LABEL_CHARS) {
    return `Please keep the name under ${MAX_LABEL_CHARS} characters.`;
  }
  return null;
}

export const STATUS_TEXT: Record<GuidelineStatus, string> = {
  processing: "Reading the guide…",
  ready: "Ready",
  failed: "Couldn't read this guide",
};

export function hasProcessing(state: GuidelineState | null): boolean {
  return Boolean(state?.documents.some((d) => d.status === "processing"));
}

export const EMPTY_GUIDELINE_STATE: GuidelineState = {
  mode: "standard",
  mode_updated_by: null,
  mode_updated_at: null,
  documents: [],
};
