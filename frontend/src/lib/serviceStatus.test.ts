import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NORMAL_SERVICE_STATE,
  READ_ONLY_DEFAULT_MESSAGE,
  READ_ONLY_ERROR_CODE,
  SERVICE_MESSAGE_MAX,
  SERVICE_POLL_MS,
  SERVICE_STATUSES,
  cleanServiceMessage,
  parseServiceStatus,
  serviceChanges,
  serviceNotice,
  serviceStateFromSettings,
  validateServiceDraft,
} from "@/lib/serviceStatus";

const repo = resolve(__dirname, "../../..");

describe("polling", () => {
  it("polls at most once per 60 seconds (the WAF limits unauthenticated requests)", () => {
    expect(SERVICE_POLL_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("parsing the public response", () => {
  it("reads a banner and a read-only state", () => {
    expect(parseServiceStatus({ service_status: "banner", service_message: " Planned work tonight. " })).toEqual({
      status: "banner",
      message: "Planned work tonight.",
    });
    expect(parseServiceStatus({ service_status: "read_only", service_message: "Paused" })).toEqual({
      status: "read_only",
      message: "Paused",
    });
  });

  it("treats anything unexpected as normal, so a bad response never blocks chat", () => {
    for (const bad of [null, undefined, "x", 4, [], {}, { service_status: "weird" }, { service_status: 1 }, { service_status: "normal", service_message: "old" }]) {
      expect(parseServiceStatus(bad)).toEqual(NORMAL_SERVICE_STATE);
    }
  });

  it("ignores a blank or non-text message", () => {
    expect(parseServiceStatus({ service_status: "banner", service_message: "   " }).message).toBeNull();
    expect(parseServiceStatus({ service_status: "banner", service_message: 5 }).message).toBeNull();
  });

  it("decides what families see", () => {
    expect(serviceNotice(NORMAL_SERVICE_STATE)).toBeNull();
    expect(serviceNotice({ status: "banner", message: "Hello" })).toBe("Hello");
    expect(serviceNotice({ status: "banner", message: null })).toBeNull();
    expect(serviceNotice({ status: "read_only", message: null })).toBe(READ_ONLY_DEFAULT_MESSAGE);
  });
});

describe("admin draft", () => {
  it("cleans the message like the server does", () => {
    expect(cleanServiceMessage("  Back\u0000 at\r\n3\tpm. ")).toBe("Back at 3 pm.");
  });

  it("requires a message for banner and read_only, and at most 500 characters", () => {
    expect(validateServiceDraft({ status: "normal", message: null })).toBeNull();
    expect(validateServiceDraft({ status: "banner", message: "" })).toMatch(/message/i);
    expect(validateServiceDraft({ status: "read_only", message: "   " })).toMatch(/message/i);
    expect(validateServiceDraft({ status: "banner", message: "a".repeat(500) })).toBeNull();
    expect(validateServiceDraft({ status: "banner", message: "a".repeat(501) })).toMatch(/500/);
  });

  it("sends only what changed, and null to clear the message", () => {
    const saved = { status: "banner" as const, message: "Old note" };
    expect(serviceChanges(saved, saved)).toEqual({});
    expect(serviceChanges(saved, { status: "read_only", message: "Old note" })).toEqual({ service_status: "read_only" });
    expect(serviceChanges(saved, { status: "banner", message: "New note" })).toEqual({ service_message: "New note" });
    expect(serviceChanges(saved, { status: "normal", message: "" })).toEqual({ service_status: "normal", service_message: null });
    expect(serviceChanges({ status: "normal", message: null }, { status: "normal", message: "   " })).toEqual({});
  });

  it("reads the admin settings response", () => {
    expect(serviceStateFromSettings({ service_status: "banner", service_message: "Hi" })).toEqual({ status: "banner", message: "Hi" });
    expect(serviceStateFromSettings({})).toEqual(NORMAL_SERVICE_STATE);
    expect(serviceStateFromSettings({ service_status: "bogus", service_message: 3 })).toEqual(NORMAL_SERVICE_STATE);
  });
});

describe("stays in sync with the backend", () => {
  it("uses the same statuses, limit and error code as the handlers and textGeneration", () => {
    const admin = readFileSync(resolve(repo, "cdk/lambda/handlers/adminHandler.js"), "utf8");
    expect(admin).toContain(`const SERVICE_STATUSES = [${SERVICE_STATUSES.map((s) => `"${s}"`).join(", ")}];`);
    expect(admin).toContain(`const SERVICE_MESSAGE_MAX = ${SERVICE_MESSAGE_MAX};`);

    const main = readFileSync(resolve(repo, "cdk/lambda/textGeneration/main.py"), "utf8");
    expect(main).toContain(`'${READ_ONLY_ERROR_CODE}'`);
    expect(main).toContain(`READ_ONLY_DEFAULT_MESSAGE = "${READ_ONLY_DEFAULT_MESSAGE}"`);
  });

  it("the public handler returns only the two fields", () => {
    const handler = readFileSync(resolve(repo, "cdk/lambda/handlers/systemMessagesHandler.js"), "utf8");
    const block = handler.slice(handler.indexOf('case "GET /system-settings/service-status"'));
    const body = block.slice(block.indexOf("JSON.stringify({"), block.indexOf("});", block.indexOf("JSON.stringify({")));
    expect(body.match(/\b(service_\w+):/g)?.sort()).toEqual(["service_message:", "service_status:"]);
  });
});
