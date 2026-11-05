// Chat refusals the backend sends as an `error` code with a family-facing
// `message`, over the WebSocket `error` event and the REST fallback body.
// Defaults match the backend constants (textGeneration/main.py and
// websocket/default.js) and are used when the server's message is missing.
// TOKEN_LIMIT_EXCEEDED, DAILY_CHARACTER_LIMIT_EXCEEDED and SERVICE_READ_ONLY
// lock the composer and are handled separately in ChatInterface.
export const CHAT_ERROR_MESSAGES = {
  GLOBAL_DAILY_LIMIT_EXCEEDED: "The assistant is very busy today. Please try again tomorrow.",
  PUBLIC_CHAT_PAUSED: "The assistant is taking a short break. Please check back a little later.",
  GENERATION_IN_PROGRESS:
    "The assistant is still working on your last message. Please wait for that answer before sending another.",
  RATE_LIMITED: "You're sending messages a little quickly. Please wait a moment, then try again.",
} as const;

export type ChatErrorCode = keyof typeof CHAT_ERROR_MESSAGES;

function isChatErrorCode(code: unknown): code is ChatErrorCode {
  return typeof code === "string" && Object.hasOwn(CHAT_ERROR_MESSAGES, code);
}

/** The message to show for a known chat error code (server's first), or null for any other code. */
export function chatErrorMessage(code: unknown, serverMessage: unknown): string | null {
  if (!isChatErrorCode(code)) return null;
  if (typeof serverMessage === "string" && serverMessage.trim()) return serverMessage;
  return CHAT_ERROR_MESSAGES[code];
}
