import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUEST_START_MESSAGES,
  GuestStartError,
  guestStartError,
  guestStartErrorFrom,
} from "./guestCreation";

const reply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("guestStartError", () => {
  it("treats a 429 as blocked, with the server's message when it sends one", async () => {
    const err = await guestStartError(reply(429, { error: "SOME_LIMIT", message: "Please wait a little." }));
    expect(err).toBeInstanceOf(GuestStartError);
    expect(err.kind).toBe("blocked");
    expect(err.message).toBe("Please wait a little.");
  });

  it("uses the default for API Gateway's throttling body", async () => {
    const err = await guestStartError(reply(429, { message: "Too Many Requests" }));
    expect(err.kind).toBe("blocked");
    expect(err.message).toBe(DEFAULT_GUEST_START_MESSAGES.blocked);
  });

  it("treats a 403 HTML page (WAF block) as blocked", async () => {
    const err = await guestStartError(reply(403, "<html><body>Forbidden</body></html>"));
    expect(err.kind).toBe("blocked");
    expect(err.message).toBe(DEFAULT_GUEST_START_MESSAGES.blocked);
  });

  it("treats server errors and unreadable bodies as unavailable", async () => {
    const err500 = await guestStartError(reply(500, { error: "Internal server error" }));
    expect(err500.kind).toBe("unavailable");
    expect(err500.message).toBe(DEFAULT_GUEST_START_MESSAGES.unavailable);
    const err502 = await guestStartError(reply(502, "Bad Gateway"));
    expect(err502.kind).toBe("unavailable");
    expect(err502.message).toBe(DEFAULT_GUEST_START_MESSAGES.unavailable);
  });

  it("ignores a blank server message", async () => {
    const err = await guestStartError(reply(429, { error: "SOME_LIMIT", message: "  " }));
    expect(err.message).toBe(DEFAULT_GUEST_START_MESSAGES.blocked);
  });
});

describe("guestStartErrorFrom", () => {
  it("wraps a thrown network or token error as unavailable", () => {
    const err = guestStartErrorFrom(new TypeError("Failed to fetch"));
    expect(err.kind).toBe("unavailable");
    expect(err.message).toBe(DEFAULT_GUEST_START_MESSAGES.unavailable);
    expect(guestStartErrorFrom("not an error").kind).toBe("unavailable");
  });

  it("keeps an existing GuestStartError", () => {
    const original = new GuestStartError("blocked");
    expect(guestStartErrorFrom(original)).toBe(original);
  });
});
