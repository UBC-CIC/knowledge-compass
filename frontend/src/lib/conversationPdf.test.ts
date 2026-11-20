import { describe, expect, it } from "vitest";
import {
  buildReviewLaterPdf,
  reviewLaterFileName,
  reviewLaterPageStreams,
  speakerLabel,
  wrapText,
  type ReviewConversation,
} from "@/lib/conversationPdf";

const conversation: ReviewConversation = {
  rating: "down",
  comment: "I wanted more information about options in my province.",
  savedAt: "2026-09-12T18:05:00.000Z",
  sessionId: "demo-feedback-2",
  messages: [
    {
      sender: "user",
      content: "What are my options if the school is in another province?",
      createdAt: "2026-09-12T18:00:00.000Z",
    },
    {
      sender: "AI",
      content: "Rules differ by province — tell me which one.",
      createdAt: "2026-09-12T18:00:20.000Z",
    },
  ],
};

describe("speakerLabel", () => {
  it("names the family and the assistant the same way chat export does", () => {
    expect(speakerLabel("user")).toBe("Guardian");
    expect(speakerLabel("AI")).toBe("Knowledge Compass");
    expect(speakerLabel("bot")).toBe("Knowledge Compass");
  });
});

describe("wrapText", () => {
  it("keeps every wrapped line within the page width", () => {
    const word = "W".repeat(80);
    const lines = wrapText(`Please ${word} today`, 11, false);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThan(80);
    }
  });
});

describe("review later PDF", () => {
  it("includes the comment and the chat it belongs to", () => {
    const pages = reviewLaterPageStreams([conversation]).join("\n");
    expect(pages).toContain("Review later");
    expect(pages).toContain("I wanted more information about options in my province.");
    expect(pages).toContain("Chat demo-feedback-2");
    expect(pages).toContain("Guardian");
    expect(pages).toContain("What are my options if the school is in another province?");
    expect(pages).toContain("Knowledge Compass");
    expect(pages).toContain("Rules differ by province \\227 tell me which one.");
  });

  it("escapes parentheses so the page text stays valid", () => {
    const pages = reviewLaterPageStreams([
      { ...conversation, comment: "See (section 1) \\ next" },
    ]).join("\n");
    expect(pages).toContain("See \\(section 1\\) \\\\ next");
  });

  it("notes when a chat could not be loaded", () => {
    const pages = reviewLaterPageStreams([
      { ...conversation, messages: [], chatUnavailable: true },
    ]).join("\n");
    expect(pages).toContain("This chat could not be loaded.");
  });

  it("starts each additional conversation on its own page", () => {
    const pages = reviewLaterPageStreams([
      conversation,
      { ...conversation, sessionId: "demo-feedback-4", comment: "Checklist for the IEP meeting." },
    ]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toContain("Comment 1 of 2");
    expect(pages[1]).toContain("Comment 2 of 2");
    expect(pages[1]).toContain("Checklist for the IEP meeting.");
    expect(pages[1]).toContain("Chat demo-feedback-4");
  });

  it("builds a PDF document", () => {
    const bytes = buildReviewLaterPdf([conversation]);
    const file = new TextDecoder().decode(bytes);
    expect(file.startsWith("%PDF-1.4")).toBe(true);
    expect(file).toContain("%%EOF");
    expect(file).toContain("/Count 1");
  });

  it("names a single chat file after its session", () => {
    expect(reviewLaterFileName()).toBe("review-later-conversations.pdf");
    expect(reviewLaterFileName("demo-feedback-2")).toBe("review-later-demo-feedback-2.pdf");
  });
});
