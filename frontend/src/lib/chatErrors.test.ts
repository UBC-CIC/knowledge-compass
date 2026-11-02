import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_ERROR_MESSAGES, chatErrorMessage } from "./chatErrors";

const repo = resolve(__dirname, "../../..");

describe("chatErrorMessage", () => {
  it("returns the default message for each known code", () => {
    for (const [code, message] of Object.entries(CHAT_ERROR_MESSAGES)) {
      expect(chatErrorMessage(code, null)).toBe(message);
      expect(chatErrorMessage(code, "   ")).toBe(message);
    }
  });

  it("prefers the server's message", () => {
    expect(chatErrorMessage("PUBLIC_CHAT_PAUSED", "Back at noon.")).toBe("Back at noon.");
  });

  it("returns null for other or missing codes", () => {
    expect(chatErrorMessage("TOKEN_LIMIT_EXCEEDED", "Limit reached")).toBeNull();
    expect(chatErrorMessage("Internal server error", null)).toBeNull();
    expect(chatErrorMessage(undefined, null)).toBeNull();
    expect(chatErrorMessage("toString", null)).toBeNull();
  });
});

describe("stays in sync with the backend", () => {
  // Python wraps long strings across lines; compare without the joins.
  const unwrap = (source: string) => source.replace(/"\s*\n\s*"/g, "");

  it("uses textGeneration's codes and messages", () => {
    const main = unwrap(readFileSync(resolve(repo, "cdk/lambda/textGeneration/main.py"), "utf8"));
    for (const code of ["GLOBAL_DAILY_LIMIT_EXCEEDED", "PUBLIC_CHAT_PAUSED", "GENERATION_IN_PROGRESS"] as const) {
      expect(main).toContain(`"${code}"`);
      expect(main).toContain(`"${CHAT_ERROR_MESSAGES[code]}"`);
    }
  });

  it("uses the WebSocket rate limit code and message", () => {
    const ws = readFileSync(resolve(repo, "cdk/lambda/websocket/default.js"), "utf8");
    expect(ws).toContain('sendErrorEvent(event, "RATE_LIMITED", RATE_LIMITED_MESSAGE)');
    expect(ws).toContain(`const RATE_LIMITED_MESSAGE = "${CHAT_ERROR_MESSAGES.RATE_LIMITED}";`);
  });
});
