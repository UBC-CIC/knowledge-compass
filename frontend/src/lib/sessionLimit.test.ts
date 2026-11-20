import { describe, expect, it } from "vitest";
import {
  DAILY_SESSION_LIMIT_CODE,
  DEFAULT_SESSION_LIMIT_MESSAGE,
  SessionLimitError,
  sessionLimitError,
} from "./sessionLimit";

const reply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("sessionLimitError", () => {
  it("returns the server's message for a daily session limit 429", async () => {
    const err = await sessionLimitError(reply(429, { error: DAILY_SESSION_LIMIT_CODE, message: "Come back tomorrow." }));
    expect(err).toBeInstanceOf(SessionLimitError);
    expect(err?.message).toBe("Come back tomorrow.");
  });

  it("falls back to the default message when the server sends none", async () => {
    const err = await sessionLimitError(reply(429, { error: DAILY_SESSION_LIMIT_CODE }));
    expect(err?.message).toBe(DEFAULT_SESSION_LIMIT_MESSAGE);
  });

  it("ignores other statuses, other 429 codes and unreadable bodies", async () => {
    expect(await sessionLimitError(reply(500, { error: DAILY_SESSION_LIMIT_CODE }))).toBeNull();
    expect(await sessionLimitError(reply(429, { error: "TOKEN_LIMIT_EXCEEDED" }))).toBeNull();
    expect(await sessionLimitError(reply(429, "not json"))).toBeNull();
  });
});
