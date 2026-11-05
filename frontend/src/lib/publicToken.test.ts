import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GUEST_START_MESSAGES, GuestStartError } from "./guestCreation";
import { getPublicToken, invalidatePublicToken } from "./publicToken";

const reply = (status: number, body: string) => new Response(body, { status });

afterEach(() => {
  vi.unstubAllGlobals();
  invalidatePublicToken();
});

describe("getPublicToken", () => {
  it.each([403, 429])("treats a %i from WAF or throttling as blocked", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(status, "<html><body>Forbidden</body></html>")));
    const err = await getPublicToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuestStartError);
    expect((err as GuestStartError).kind).toBe("blocked");
    expect((err as GuestStartError).message).toBe(DEFAULT_GUEST_START_MESSAGES.blocked);
  });

  it("keeps other failures generic, so they show as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(500, "error")));
    const err = await getPublicToken().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GuestStartError);
  });

  it("returns the token on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, JSON.stringify({ token: "t1" }))));
    await expect(getPublicToken()).resolves.toBe("t1");
  });
});
