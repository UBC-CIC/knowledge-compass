// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ServiceStatusCard from "@/components/Admin/ServiceStatusCard";
import type { ServicePatch, ServiceState } from "@/lib/serviceStatus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

type Props = { saved: ServiceState; onSave: (patch: ServicePatch) => Promise<void>; breakGlassPaused?: boolean };

function render(props: Props) {
  act(() => root.render(<ServiceStatusCard {...props} />));
}

// The dialog renders in a portal on document.body, so search the whole document.
const buttons = () => [...document.querySelectorAll("button")];
const button = (name: RegExp) => {
  const hit = buttons().find((b) => name.test(b.textContent ?? ""));
  if (!hit) throw new Error(`no button ${name}`);
  return hit;
};
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

function choose(status: ServiceState["status"]) {
  const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${status}"]`)!;
  act(() => radio.click());
}

function typeMessage(text: string) {
  const textarea = container.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const NORMAL: ServiceState = { status: "normal", message: null };
const PAUSED: ServiceState = { status: "read_only", message: "Back at 3 pm." };

describe("pausing public chat asks first", () => {
  it("opens an accessible 'Are you sure?' dialog on save and saves nothing yet", async () => {
    const onSave = vi.fn(async () => {});
    render({ saved: NORMAL, onSave });
    choose("read_only");
    typeMessage("Back at 3 pm.");

    await click(button(/Save service status/));

    expect(onSave).not.toHaveBeenCalled();
    const d = dialog();
    expect(d).not.toBeNull();
    // Labelled and described for screen readers, and focus is inside it.
    const title = document.getElementById(d!.getAttribute("aria-labelledby")!);
    expect(title?.textContent).toBe("Are you sure?");
    const description = document.getElementById(d!.getAttribute("aria-describedby")!);
    expect(description?.textContent).toMatch(/cannot send new messages/i);
    expect(d!.contains(document.activeElement)).toBe(true);
  });

  it("Cancel closes the dialog, saves nothing and keeps the draft", async () => {
    const onSave = vi.fn(async () => {});
    render({ saved: NORMAL, onSave });
    choose("read_only");
    typeMessage("Back at 3 pm.");
    await click(button(/Save service status/));

    await click(button(/^Cancel$/));

    expect(dialog()).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[value="read_only"]')!.checked).toBe(true);
    expect(container.textContent).toContain("Unsaved changes.");
  });

  it("Confirm saves the pause and closes the dialog", async () => {
    const onSave = vi.fn(async () => {});
    render({ saved: NORMAL, onSave });
    choose("read_only");
    typeMessage("Back at 3 pm.");
    await click(button(/Save service status/));

    await click(button(/Yes, pause new messages/));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ service_status: "read_only", service_message: "Back at 3 pm." });
    expect(dialog()).toBeNull();
  });

  it("a failed save keeps the dialog open and shows why", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("Network down");
    });
    render({ saved: NORMAL, onSave });
    choose("read_only");
    typeMessage("Back at 3 pm.");
    await click(button(/Save service status/));
    await act(async () => {
      button(/Yes, pause new messages/).click();
    });

    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain("Network down");
  });

  it("a banner saves without asking", async () => {
    const onSave = vi.fn(async () => {});
    render({ saved: NORMAL, onSave });
    choose("banner");
    typeMessage("Planned work tonight.");
    await click(button(/Save service status/));

    expect(dialog()).toBeNull();
    expect(onSave).toHaveBeenCalledWith({ service_status: "banner", service_message: "Planned work tonight." });
  });

  it("editing the message while already paused does not ask again", async () => {
    const onSave = vi.fn(async () => {});
    render({ saved: PAUSED, onSave });
    typeMessage("Back at 4 pm.");
    await click(button(/Save service status/));

    expect(dialog()).toBeNull();
    expect(onSave).toHaveBeenCalledWith({ service_message: "Back at 4 pm." });
  });
});

describe("resuming public chat", () => {
  it("shows that chat is paused, and Resume turns it back on without a dialog", async () => {
    const onSave = vi.fn(async () => {});
    render({ saved: PAUSED, onSave });
    const notice = container.querySelector('[role="status"]');
    expect(notice?.textContent).toMatch(/Public chat is paused/);

    await click(button(/Resume public chat/));

    expect(dialog()).toBeNull();
    expect(onSave).toHaveBeenCalledWith({ service_status: "normal" });
  });

  it("choosing Normal and saving also resumes, without a dialog", async () => {
    const onSave = vi.fn(async () => {});
    render({ saved: PAUSED, onSave });
    choose("normal");
    await click(button(/Save service status/));

    expect(dialog()).toBeNull();
    expect(onSave).toHaveBeenCalledWith({ service_status: "normal" });
  });

  it("no paused notice while chat runs normally", () => {
    render({ saved: NORMAL, onSave: vi.fn(async () => {}) });
    expect(container.textContent).not.toMatch(/Public chat is paused/);
    expect(buttons().some((b) => /Resume public chat/.test(b.textContent ?? ""))).toBe(false);
  });
});

describe("the AWS break-glass switch", () => {
  it("shows a read-only notice, opened, when the switch has paused chat", () => {
    render({ saved: NORMAL, onSave: vi.fn(async () => {}), breakGlassPaused: true });
    const notice = [...container.querySelectorAll('[role="status"]')].find((n) =>
      /PublicChatEnabled/.test(n.textContent ?? "")
    );
    expect(notice).toBeDefined();
    expect(notice!.textContent).toMatch(/can't be turned back on from this page/i);
    // The card opens so the notice is visible even when the status here is Normal.
    expect(container.querySelector("[hidden]")).toBeNull();
  });

  it("shows nothing when the switch is on or unknown", () => {
    render({ saved: NORMAL, onSave: vi.fn(async () => {}), breakGlassPaused: false });
    expect(container.textContent).not.toMatch(/PublicChatEnabled/);
    act(() => root.render(<ServiceStatusCard saved={NORMAL} onSave={vi.fn(async () => {})} />));
    expect(container.textContent).not.toMatch(/PublicChatEnabled/);
  });
});
