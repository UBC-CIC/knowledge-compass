import { describe, expect, it } from "vitest";
import {
  EMPTY_GUIDELINE_STATE,
  MAX_GUIDE_BYTES,
  MAX_LABEL_CHARS,
  hasProcessing,
  isMarkdownFileName,
  normalizeLabel,
  validateGuideFile,
  validateLabel,
} from "@/lib/guideline";

describe("guide files", () => {
  it("accepts Markdown files", () => {
    expect(isMarkdownFileName("Guide.MD")).toBe(true);
    expect(isMarkdownFileName("notes.markdown")).toBe(true);
    expect(validateGuideFile({ name: "guide.md", size: 10 })).toBeNull();
  });

  it("rejects other types, empty and large files", () => {
    expect(validateGuideFile({ name: "guide.pdf", size: 10 })).toMatch(/isn't a Markdown file/);
    expect(validateGuideFile({ name: "guide.md", size: 0 })).toMatch(/empty/);
    expect(validateGuideFile({ name: "guide.md", size: MAX_GUIDE_BYTES + 1 })).toMatch(/1 MB/);
  });
});

describe("situation labels", () => {
  it("normalizes whitespace", () => {
    expect(normalizeLabel("  Sent   home\nearly ")).toBe("Sent home early");
  });

  it("allows empty (reset) and caps length", () => {
    expect(validateLabel("")).toBeNull();
    expect(validateLabel("x".repeat(MAX_LABEL_CHARS))).toBeNull();
    expect(validateLabel("x".repeat(MAX_LABEL_CHARS + 1))).toMatch(/under 80/);
  });
});

describe("polling", () => {
  it("polls only while a guide is processing", () => {
    expect(hasProcessing(null)).toBe(false);
    expect(hasProcessing(EMPTY_GUIDELINE_STATE)).toBe(false);
    const doc = {
      id: "1", file_name: "g.md", status: "processing" as const, error: null, section_count: 0,
      uploaded_by: null, created_at: "", updated_at: "", sections: [],
    };
    expect(hasProcessing({ ...EMPTY_GUIDELINE_STATE, documents: [doc] })).toBe(true);
  });
});
