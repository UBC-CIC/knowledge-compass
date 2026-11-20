// POST /chat_sessions answers 429 DAILY_SESSION_LIMIT_EXCEEDED once a user has
// started the day's maximum number of new chats (cdk chatSessionHandler.js).
// Existing chats stay usable, so the composer is not locked.

export const DAILY_SESSION_LIMIT_CODE = "DAILY_SESSION_LIMIT_EXCEEDED";

export const DEFAULT_SESSION_LIMIT_MESSAGE =
  "You've started the most new chats allowed for today. You can keep going in one of your existing chats, or start a new one tomorrow.";

export class SessionLimitError extends Error {
  constructor(message: string = DEFAULT_SESSION_LIMIT_MESSAGE) {
    super(message);
    this.name = "SessionLimitError";
  }
}

/** A SessionLimitError when the failed create was the daily session limit, else null. */
export async function sessionLimitError(response: Response): Promise<SessionLimitError | null> {
  if (response.status !== 429) return null;
  const body = await response.json().catch(() => null);
  if (body?.error !== DAILY_SESSION_LIMIT_CODE) return null;
  const message = typeof body.message === "string" && body.message.trim() ? body.message : undefined;
  return new SessionLimitError(message);
}
