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
  sections: GuidelineSection[];
};

export type GuidelineState = {
  mode: GuidelineMode;
  mode_updated_by: string | null;
  mode_updated_at: string | null;
  documents: GuidelineDocument[];
};

export const MAX_GUIDE_BYTES = 1024 * 1024;
export const MAX_LABEL_CHARS = 80;
export const MARKDOWN_ACCEPT = ".md,.markdown,text/markdown";

export function isMarkdownFileName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** Plain-language problem with a chosen file, or null when it can be uploaded. */
export function validateGuideFile(file: { name: string; size: number }): string | null {
  if (!isMarkdownFileName(file.name)) {
    return `"${file.name}" isn't a Markdown file. Please choose a .md or .markdown file.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_GUIDE_BYTES) {
    return `"${file.name}" is larger than 1 MB. Please split it into smaller files.`;
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
