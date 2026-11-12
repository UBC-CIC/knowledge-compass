import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROBE_SESSION_ID, PUBLIC_CHAT_PAUSED_CODE, isPublicChatPausedBySwitch } from "./publicChatSwitch";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** fetch stub: the token request, then the text_generation probe. */
function stubFetch(probe: () => Response | Promise<Response>, token: () => Response = () => json(200, { token: "anon" })) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
    return String(input).endsWith("/user/publicToken") ? token() : probe();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPublicChatPausedBySwitch", () => {
  it("is true only for 429 PUBLIC_CHAT_PAUSED", async () => {
    stubFetch(() => json(429, { error: PUBLIC_CHAT_PAUSED_CODE, message: "Paused" }));
    await expect(isPublicChatPausedBySwitch()).resolves.toBe(true);
  });

  it("asks anonymously, with an empty body, for the nil session", async () => {
    const fetchMock = stubFetch(() => json(401, { error: "A user session token is required" }));
    await isPublicChatPausedBySwitch();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(String(tokenUrl)).toMatch(/\/user\/publicToken$/);
    // No stored guest credential is sent, so nothing is rotated or bound to a family.
    expect(new Headers(tokenInit?.headers).has("Authorization")).toBe(false);

    const [probeUrl, probeInit] = fetchMock.mock.calls[1];
    expect(String(probeUrl)).toMatch(new RegExp(`/chat_sessions/${PROBE_SESSION_ID}/text_generation$`));
    expect(probeInit?.method).toBe("POST");
    expect(probeInit?.body).toBe("{}");
    expect(new Headers(probeInit?.headers).get("Authorization")).toBe("Bearer anon");
  });

  it("fails open: any other answer or error is not a pause", async () => {
    for (const probe of [
      () => json(401, { error: "A user session token is required" }),
      () => json(400, { error: "Missing query or chat_session_id" }),
      () => json(429, { error: "GLOBAL_DAILY_LIMIT_EXCEEDED" }),
      () => new Response("<html>Too many</html>", { status: 429 }),
      () => json(503, { error: "SERVICE_READ_ONLY" }),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]) {
      stubFetch(probe);
      await expect(isPublicChatPausedBySwitch()).resolves.toBe(false);
    }
  });

  it("relies on textGeneration checking the switch before the caller and the database", () => {
    const main = readFileSync(resolve(__dirname, "../../../cdk/lambda/textGeneration/main.py"), "utf8");
    expect(main).toContain(`PUBLIC_CHAT_PAUSED_ERROR = "${PUBLIC_CHAT_PAUSED_CODE}"`);
    const handler = main.slice(main.indexOf("def handler("));
    const check = handler.indexOf("if not is_public_chat_enabled():");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(handler.indexOf("resolve_caller_user_id("));
    expect(check).toBeLessThan(handler.indexOf("get_db_connection()"));
  });

  it("does not probe without a token", async () => {
    for (const token of [() => json(403, {}), () => json(200, {}), () => new Response("not json", { status: 200 })]) {
      const fetchMock = stubFetch(() => json(429, { error: PUBLIC_CHAT_PAUSED_CODE }), token);
      await expect(isPublicChatPausedBySwitch()).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});
