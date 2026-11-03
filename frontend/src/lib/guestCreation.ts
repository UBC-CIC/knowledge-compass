// POST /user creates the anonymous guest a family chats as. When it fails the
// chat page cannot start, so the provider keeps one of these errors and the
// page shows its message with a retry.
//   blocked:     429 (API Gateway throttling) or 403 (a WAF block, often an
//                HTML body) on POST /user or the /user/publicToken request
//                before it. Usually clears after a short wait.
//   unavailable: anything else (5xx, unreadable body, network failure, or the
//                public token request failing for another reason).
export type GuestStartErrorKind = "blocked" | "unavailable";

export const DEFAULT_GUEST_START_MESSAGES: Record<GuestStartErrorKind, string> = {
  blocked: "We couldn't start your chat just now. Please wait a few minutes and try again.",
  unavailable: "Something went wrong on our side while starting your chat. Please try again in a moment.",
};

export class GuestStartError extends Error {
  readonly kind: GuestStartErrorKind;
  constructor(kind: GuestStartErrorKind, message: string = DEFAULT_GUEST_START_MESSAGES[kind]) {
    super(message);
    this.name = "GuestStartError";
    this.kind = kind;
  }
}

/** The GuestStartError for a failed POST /user response. */
export async function guestStartError(response: Response): Promise<GuestStartError> {
  const kind: GuestStartErrorKind =
    response.status === 429 || response.status === 403 ? "blocked" : "unavailable";
  const body = await response.json().catch(() => null);
  // Only a message our own handlers wrote (an `error` code plus `message`) is
  // shown. API Gateway's default bodies ({"message": "Forbidden"}) are not.
  const message =
    typeof body?.error === "string" && typeof body.message === "string" && body.message.trim()
      ? body.message
      : undefined;
  return new GuestStartError(kind, message);
}

/** Wraps anything thrown while creating a guest; non-GuestStartErrors become "unavailable". */
export function guestStartErrorFrom(err: unknown): GuestStartError {
  return err instanceof GuestStartError ? err : new GuestStartError("unavailable");
}
