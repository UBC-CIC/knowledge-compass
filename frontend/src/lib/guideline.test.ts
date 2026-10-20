import { describe, expect, it } from "vitest";
import {
  EMPTY_GUIDELINE_STATE,
  GUIDE_FILE_TYPES,
  MAX_LABEL_CHARS,
  guideFileKind,
  hasProcessing,
  coveredSituationNames,
  normalizeLabel,
  situationName,
  validateGuideFile,
  validateLabel,
  type GuidelineDocument,
} from "@/lib/guideline";

describe("guide files", () => {
  it("accepts Markdown, Word and PDF files", () => {
    expect(guideFileKind("Guide.MD")).toBe("markdown");
    expect(guideFileKind("notes.markdown")).toBe("markdown");
    expect(guideFileKind("Guide.docx")).toBe("docx");
    expect(guideFileKind("Guide.PDF")).toBe("pdf");
    for (const name of ["guide.md", "guide.docx", "guide.pdf"]) {
      expect(validateGuideFile({ name, size: 10 })).toBeNull();
    }
  });

  it("rejects other types, empty and large files", () => {
    expect(validateGuideFile({ name: "guide.doc", size: 10 })).toMatch(/can't be used/);
    expect(validateGuideFile({ name: "guide.txt", size: 10 })).toMatch(/can't be used/);
    expect(validateGuideFile({ name: "guide.md", size: 0 })).toMatch(/empty/);
    expect(validateGuideFile({ name: "guide.md", size: GUIDE_FILE_TYPES.markdown.maxBytes + 1 })).toMatch(/1 MB/);
    expect(validateGuideFile({ name: "guide.pdf", size: 5 * 1024 * 1024 })).toBeNull();
    expect(validateGuideFile({ name: "guide.pdf", size: GUIDE_FILE_TYPES.pdf.maxBytes + 1 })).toMatch(/10 MB/);
  });
});

describe("covered situations", () => {
  const doc = (status: GuidelineDocument["status"], heading: string): GuidelineDocument => ({
    id: heading,
    file_name: "g.md",
    status,
    error: null,
    section_count: 1,
    uploaded_by: null,
    created_at: "",
    updated_at: "",
    journey_id: "j",
    sections: [
      {
        id: "s",
        section_key: heading,
        heading_path: heading,
        auto_label: heading,
        label_override: null,
        label: heading,
        summary: null,
      },
    ],
  });

  it("uses the situation heading and ignores files that are not ready", () => {
    expect(situationName("Journey > Sent home early")).toBe("sent home early");
    expect(coveredSituationNames([doc("ready", "Journey > Sent home early"), doc("processing", "Journey > Other")])).toEqual(
      new Set(["sent home early"])
    );
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
      uploaded_by: null, created_at: "", updated_at: "", journey_id: null, sections: [],
    };
    expect(hasProcessing({ ...EMPTY_GUIDELINE_STATE, documents: [doc] })).toBe(true);
  });
});
