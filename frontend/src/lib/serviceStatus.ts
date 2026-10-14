/**
 * Service status (maintenance banner / read-only fallback, migration 034).
 *
 *   normal     nothing changes
 *   banner     families see the message above the chat; chat keeps working
 *   read_only  families see the message, the message box is disabled and a new turn is refused
 *
 * Shared by the chat page (public read), the banner component and the admin
 * "Assistant settings" card. Limits mirror PUT /admin/system-settings in
 * cdk/lambda/handlers/adminHandler.js.
 *
 * The public read (GET /system-settings/service-status) returns ONLY service_status and
 * service_message and is readable by any visitor, so write the message accordingly.
 */

export type ServiceStatus = "normal" | "banner" | "read_only";

export type ServiceState = { status: ServiceStatus; message: string | null };

export const SERVICE_STATUSES: ServiceStatus[] = ["normal", "banner", "read_only"];
export const NORMAL_SERVICE_STATE: ServiceState = { status: "normal", message: null };

/** How often the chat page asks again. The API response may be cached for 30 s; once a minute is plenty. */
export const SERVICE_POLL_MS = 60_000;
export const SERVICE_MESSAGE_MAX = 500;
/** WebSocket `error` code sent by textGeneration when a new turn is refused. */
export const READ_ONLY_ERROR_CODE = "SERVICE_READ_ONLY";
export const READ_ONLY_DEFAULT_MESSAGE = "Chat is temporarily read-only. Please try again later.";

export const SERVICE_OPTIONS: Array<{ value: ServiceStatus; title: string; body: string }> = [
  {
    value: "normal",
    title: "Normal",
    body: "Nothing is shown. Chat works as usual.",
  },
  {
    value: "banner",
    title: "Show a banner",
    body: "Families see your message above the chat. Chat keeps working.",
  },
  {
    value: "read_only",
    title: "Pause new messages (read-only)",
    body: "Families see your message and cannot send new messages. They can still read earlier chats.",
  },
];

/** Defensive parse of the public response; anything unexpected means "normal". */
export function parseServiceStatus(data: unknown): ServiceState {
  if (typeof data !== "object" || data === null) return NORMAL_SERVICE_STATE;
  const record = data as Record<string, unknown>;
  const status = SERVICE_STATUSES.find((s) => s === record.service_status);
  if (!status || status === "normal") return NORMAL_SERVICE_STATE;
  const message =
    typeof record.service_message === "string" && record.service_message.trim() ? record.service_message.trim() : null;
  return { status, message };
}

/** The text a family sees for this state, or null when nothing should be shown. */
export function serviceNotice(state: ServiceState): string | null {
  if (state.status === "normal") return null;
  return state.message ?? (state.status === "read_only" ? READ_ONLY_DEFAULT_MESSAGE : null);
}

/** Same cleaning as the server: control characters and runs of whitespace become one space. */
export function cleanServiceMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
}

/** Problem with a draft, in plain language, or null when it can be saved. */
export function validateServiceDraft(draft: ServiceState): string | null {
  const message = cleanServiceMessage(draft.message ?? "");
  if (message.length > SERVICE_MESSAGE_MAX) {
    return `Keep the message under ${SERVICE_MESSAGE_MAX} characters (it is ${message.length} now).`;
  }
  if (draft.status !== "normal" && message === "") {
    return "Write the message families will see.";
  }
  return null;
}

/** PUT body for the service fields. A missing key keeps the stored value; service_message null clears it. */
export type ServicePatch = { service_status?: ServiceStatus; service_message?: string | null };

/** The changes between what is saved and the draft; empty when nothing changed. */
export function serviceChanges(saved: ServiceState, draft: ServiceState): ServicePatch {
  const patch: ServicePatch = {};
  const nextMessage = cleanServiceMessage(draft.message ?? "") || null;
  if (draft.status !== saved.status) patch.service_status = draft.status;
  // null clears the stored message; leaving the key out keeps it.
  if (nextMessage !== (saved.message ?? null)) patch.service_message = nextMessage;
  return patch;
}

/** API response of GET /admin/system-settings (or the PUT) -> service state. */
export function serviceStateFromSettings(data: { service_status?: unknown; service_message?: unknown }): ServiceState {
  const status = SERVICE_STATUSES.find((s) => s === data.service_status) ?? "normal";
  const message = typeof data.service_message === "string" ? data.service_message : null;
  return { status, message };
}
