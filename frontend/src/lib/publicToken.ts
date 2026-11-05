/**
 * Anonymous user identity and API access tokens.
 *
 * POST /user returns a user id plus a 30-day credential. Both are kept in
 * localStorage; the credential is exchanged at /user/publicToken for 15-minute
 * access tokens bound to that user, which user and session routes require.
 * The server rotates the credential about daily (the response then carries the
 * replacement) and revokes it if a superseded copy is reused. Without a
 * credential, /user/publicToken returns an anonymous token that can only
 * create a user and read public settings.
 */
import { API_ENDPOINT } from "@/lib/api";
import { guestStartError } from "@/lib/guestCreation";

const STORAGE_KEY = "knowledgeCompass_user_session";

/** Dispatched on window when the stored credential stops working. */
export const CREDENTIAL_REJECTED_EVENT = "knowledgeCompass:credential-rejected";
// Access tokens live 15 minutes; refresh well before that.
const TOKEN_REUSE_MS = 10 * 60 * 1000;

export interface StoredUserSession {
  userId: string;
  credential: string;
  createdAt?: string;
}

/** The credential was rejected (expired or from another deployment). */
export class CredentialRejectedError extends Error {
  constructor() {
    super("Stored user credential was rejected");
    this.name = "CredentialRejectedError";
  }
}

export function readUserSession(): StoredUserSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredUserSession>;
    // Sessions saved before credentials existed cannot prove ownership.
    if (typeof parsed.userId !== "string" || typeof parsed.credential !== "string") return null;
    return { userId: parsed.userId, credential: parsed.credential, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

export function saveUserSession(session: StoredUserSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    console.warn("Failed to store user in localStorage");
  }
  cached = null;
}

export function clearUserSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable; nothing to clear.
  }
  cached = null;
}

let cached: { credential: string | null; token: string; fetchedAt: number } | null = null;
let inFlight: { credential: string | null; promise: Promise<string> } | null = null;

async function requestToken(credential: string | null): Promise<string> {
  const response = await fetch(`${API_ENDPOINT}/user/publicToken`, {
    headers: credential ? { Authorization: `Bearer ${credential}` } : undefined,
  });
  if (response.status === 401 && credential) {
    clearUserSession();
    window.dispatchEvent(new Event(CREDENTIAL_REJECTED_EVENT));
    throw new CredentialRejectedError();
  }
  // The token handler never sends 403 or 429; those come from WAF or API
  // Gateway throttling, so tell the family to wait rather than "unavailable".
  if (response.status === 403 || response.status === 429) throw await guestStartError(response);
  if (!response.ok) throw new Error("Failed to get public token");
  const { token, credential: rotated } = (await response.json()) as {
    token?: string;
    credential?: string;
  };
  if (!token) throw new Error("Public token response missing token");
  // Credentials rotate daily; the old one stops working, so replace it now.
  if (credential && rotated) {
    const session = readUserSession();
    if (session && session.credential === credential) {
      saveUserSession({ ...session, credential: rotated });
    }
  }
  return token;
}

/**
 * An access token for API and WebSocket calls: bound to the stored user when
 * a credential exists, otherwise anonymous. Reused for 10 minutes, and
 * concurrent callers share one request.
 */
export async function getPublicToken(): Promise<string> {
  const credential = readUserSession()?.credential ?? null;
  if (cached && cached.credential === credential && Date.now() - cached.fetchedAt < TOKEN_REUSE_MS) {
    return cached.token;
  }
  if (inFlight && inFlight.credential === credential) return inFlight.promise;

  const promise = requestToken(credential)
    .then((token) => {
      // Key by the credential stored now, which a rotation may have replaced.
      cached = { credential: readUserSession()?.credential ?? null, token, fetchedAt: Date.now() };
      return token;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { credential, promise };
  return promise;
}

/** Drop the cached access token so the next getPublicToken() fetches a new one. */
export function invalidatePublicToken(): void {
  cached = null;
}
