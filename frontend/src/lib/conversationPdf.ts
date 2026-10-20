import { AuthService } from "@/functions/authService";
import { API_ENDPOINT } from "@/lib/api";
import { DEMO_ADMIN_MESSAGES, isDemoMode } from "@/lib/demo";

/**
 * Builds a Review Later PDF: each saved comment, then the chat it belongs to.
 * Standard PDF fonts (Helvetica) so the file needs no embedded font.
 */

export type TranscriptMessage = {
  sender: string;
  content: string;
  createdAt: string;
};

export type ReviewConversation = {
  rating: "up" | "down";
  comment: string;
  savedAt: string;
  sessionId: string;
  messages: TranscriptMessage[];
  /** The comment is included, but its chat could not be loaded. */
  chatUnavailable?: boolean;
};

type TextItem = {
  kind: "text";
  text: string;
  font: "F1" | "F2";
  size: number;
  leading: number;
};

type FlowItem = TextItem | { kind: "gap"; leading: number } | { kind: "break" };

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 54;
const MARGIN_TOP = 78;
const MARGIN_BOTTOM = 52;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const MESSAGE_PAGE = 200;
const MESSAGE_CAP = 1000;

// Helvetica widths in 1000-unit ems, from space (32) through tilde (126).
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  222, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const WIN_ANSI: Record<string, number> = {
  "\u2014": 0x97,
  "\u2013": 0x96,
  "\u2018": 0x91,
  "\u2019": 0x92,
  "\u201c": 0x93,
  "\u201d": 0x94,
  "\u2022": 0x95,
  "\u2026": 0x85,
  "\u00a0": 0xa0,
};

function charUnits(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return HELVETICA[code - 32];
  return 900;
}

function textWidth(text: string, size: number, bold: boolean): number {
  let units = 0;
  for (const ch of text) units += charUnits(ch);
  return (units / 1000) * size * (bold ? 1.12 : 1);
}

/** Wraps on spaces, then breaks a single word that is wider than the page. */
export function wrapText(text: string, size: number, bold: boolean, maxWidth = CONTENT_W): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    const pushWord = (word: string) => {
      if (!current) {
        current = word;
        return;
      }
      const next = `${current} ${word}`;
      if (textWidth(next, size, bold) <= maxWidth) current = next;
      else {
        lines.push(current);
        current = word;
      }
    };
    for (const word of words) {
      if (textWidth(word, size, bold) <= maxWidth) {
        pushWord(word);
        continue;
      }
      if (current) {
        lines.push(current);
        current = "";
      }
      let piece = "";
      for (const ch of word) {
        const next = piece + ch;
        if (piece && textWidth(next, size, bold) > maxWidth) {
          lines.push(piece);
          piece = ch;
        } else {
          piece = next;
        }
      }
      current = piece;
    }
    if (current) lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function pdfLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    const mapped = WIN_ANSI[ch];
    const code = ch.codePointAt(0) ?? 0x3f;
    let byte = mapped ?? (code >= 0x20 && code <= 0x7e ? code : code >= 0xa1 && code <= 0xff ? code : 0x3f);
    if (byte === 0x5c || byte === 0x28 || byte === 0x29) {
      out += `\\${String.fromCharCode(byte)}`;
    } else if (byte < 0x20 || byte > 0x7e) {
      out += `\\${byte.toString(8).padStart(3, "0")}`;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

function clip(text: string): string {
  const clean = text.replace(/\u0000/g, "");
  if (clean.length <= 20000) return clean;
  return `${clean.slice(0, 20000)}...`;
}

export function speakerLabel(sender: string): string {
  const value = sender.toLowerCase();
  if (value === "user") return "Guardian";
  if (value === "ai" || value === "bot" || value === "assistant") return "Knowledge Compass";
  return sender.trim() || "Message";
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function textItem(text: string, font: "F1" | "F2", size: number, leading: number): TextItem[] {
  return wrapText(text, size, font === "F2").map((line) => ({
    kind: "text",
    text: line,
    font,
    size,
    leading,
  }));
}

function conversationItems(conversation: ReviewConversation, index: number, total: number): FlowItem[] {
  const rating = conversation.rating === "up" ? "Helpful" : "Not helpful";
  const heading = total > 1 ? `Comment ${index + 1} of ${total}` : "Comment";
  const saved = formatWhen(conversation.savedAt);
  const items: FlowItem[] = [];
  if (index > 0) items.push({ kind: "break" });
  items.push(...textItem(heading, "F2", 13, 18));
  items.push(...textItem(`${rating}${saved ? `  ·  ${saved}` : ""}`, "F1", 10, 14));
  items.push(...textItem(`Chat ${conversation.sessionId}`, "F1", 9, 13));
  items.push({ kind: "gap", leading: 8 });
  items.push(...textItem(clip(conversation.comment).trim() || "(No comment text)", "F1", 11, 15));
  items.push({ kind: "gap", leading: 12 });
  items.push(...textItem("Conversation", "F2", 13, 18));

  if (conversation.chatUnavailable) {
    items.push(...textItem("This chat could not be loaded.", "F1", 11, 15));
    return items;
  }
  if (conversation.messages.length === 0) {
    items.push(...textItem("No messages were found for this chat.", "F1", 11, 15));
    return items;
  }

  for (const message of conversation.messages) {
    const when = formatWhen(message.createdAt);
    items.push({ kind: "gap", leading: 8 });
    items.push(
      ...textItem(
        `${speakerLabel(message.sender)}${when ? `  ·  ${when}` : ""}`,
        "F2",
        10,
        14
      )
    );
    items.push(...textItem(clip(message.content).trim() || "(Empty message)", "F1", 11, 15));
  }
  return items;
}

function paginate(items: FlowItem[]): TextItem[][] {
  const pages: TextItem[][] = [[]];
  let y = PAGE_H - MARGIN_TOP;

  const nextPage = () => {
    pages.push([]);
    y = PAGE_H - MARGIN_TOP;
  };

  for (const item of items) {
    if (item.kind === "break") {
      if (pages[pages.length - 1].length > 0) nextPage();
      continue;
    }
    if (item.kind === "gap") {
      if (y - item.leading >= MARGIN_BOTTOM) y -= item.leading;
      continue;
    }
    if (y < MARGIN_BOTTOM) nextPage();
    pages[pages.length - 1].push(item);
    y -= item.leading;
  }

  return pages.filter((page) => page.length > 0);
}

function renderPage(lines: TextItem[], pageNumber: number, pageCount: number): string {
  const commands = [
    "0.35 0.35 0.35 rg",
    "BT",
    "/F1 9 Tf",
    `1 0 0 1 ${MARGIN_X} ${PAGE_H - 40} Tm`,
    `(${pdfLiteral("Knowledge Compass  ·  Review later")}) Tj`,
    "ET",
    "BT",
    "/F1 9 Tf",
    `1 0 0 1 ${MARGIN_X} 32 Tm`,
    `(${pdfLiteral(`Page ${pageNumber} of ${pageCount}`)}) Tj`,
    "ET",
    "0 0 0 rg",
    "BT",
  ];

  let y = PAGE_H - MARGIN_TOP;
  for (const line of lines) {
    commands.push(`/${line.font} ${line.size} Tf`);
    commands.push(`1 0 0 1 ${MARGIN_X} ${y.toFixed(2)} Tm`);
    commands.push(`(${pdfLiteral(line.text)}) Tj`);
    y -= line.leading;
  }
  commands.push("ET");
  return commands.join("\n");
}

/** Page content streams, one string per page. Useful for tests. */
export function reviewLaterPageStreams(conversations: ReviewConversation[]): string[] {
  const items: FlowItem[] = [
    ...textItem("Review later", "F2", 18, 24),
    ...textItem(
      conversations.length === 1
        ? "The comment and the chat it was left on."
        : `${conversations.length} comments, each with the chat it was left on.`,
      "F1",
      10,
      14
    ),
    { kind: "gap", leading: 16 },
  ];
  conversations.forEach((conversation, index) => {
    items.push(...conversationItems(conversation, index, conversations.length));
  });
  const pages = paginate(items);
  const count = Math.max(pages.length, 1);
  return (pages.length > 0 ? pages : [[]]).map((page, index) => renderPage(page, index + 1, count));
}

function assemblePdf(pageStreams: string[]): Uint8Array {
  const objects = [""];
  const add = (body: string) => {
    objects.push(body);
    return objects.length - 1;
  };

  const pagesId = add("");
  const regularId = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  );
  const boldId = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
  );

  const pageIds: number[] = [];
  for (const stream of pageStreams) {
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${regularId} 0 R /F2 ${boldId} 0 R >> >> >>`
      )
    );
  }

  objects[pagesId] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let file = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets.push(file.length);
    file += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = file.length;
  file += `xref\n0 ${objects.length}\n`;
  file += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id += 1) {
    file += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  file += `trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(file);
}

export function buildReviewLaterPdf(conversations: ReviewConversation[]): Uint8Array {
  return assemblePdf(reviewLaterPageStreams(conversations));
}

export function reviewLaterFileName(sessionId?: string): string {
  if (!sessionId) return "review-later-conversations.pdf";
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return `review-later-${safe || "conversation"}.pdf`;
}

export function downloadPdfFile(bytes: Uint8Array, fileName: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function asMessages(rows: unknown): TranscriptMessage[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    return [
      {
        sender: typeof record.sender === "string" ? record.sender : "unknown",
        content: typeof record.content === "string" ? record.content : "",
        createdAt: typeof record.created_at === "string" ? record.created_at : "",
      },
    ];
  });
}

/** Messages for one chat, oldest first. Demo mode uses the local sample chats. */
export async function loadChatTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  if (isDemoMode) return asMessages(DEMO_ADMIN_MESSAGES[sessionId]);

  const token = await AuthService.getAdminIdToken();
  const messages: TranscriptMessage[] = [];
  let offset = 0;
  while (messages.length < MESSAGE_CAP) {
    const url =
      `${API_ENDPOINT}/admin/chat_sessions/${encodeURIComponent(sessionId)}/messages` +
      `?limit=${MESSAGE_PAGE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: token, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error("Failed to load conversation");
    const page = asMessages(await res.json());
    messages.push(...page);
    if (page.length < MESSAGE_PAGE) break;
    offset += MESSAGE_PAGE;
  }
  return messages.slice(0, MESSAGE_CAP);
}

export type ReviewLaterEntry = {
  chatSessionId: string;
  rating: "up" | "down";
  comment: string;
  updatedAt: string;
};

/** Loads each entry's chat and returns a PDF. A failed chat is noted inside the file. */
export async function buildReviewLaterDownload(
  entries: ReviewLaterEntry[]
): Promise<{ bytes: Uint8Array; missingChats: number }> {
  let missingChats = 0;
  const conversations: ReviewConversation[] = [];
  for (const entry of entries) {
    try {
      const messages = await loadChatTranscript(entry.chatSessionId);
      conversations.push({
        rating: entry.rating,
        comment: entry.comment,
        savedAt: entry.updatedAt,
        sessionId: entry.chatSessionId,
        messages,
      });
    } catch {
      missingChats += 1;
      conversations.push({
        rating: entry.rating,
        comment: entry.comment,
        savedAt: entry.updatedAt,
        sessionId: entry.chatSessionId,
        messages: [],
        chatUnavailable: true,
      });
    }
  }
  return { bytes: buildReviewLaterPdf(conversations), missingChats };
}
