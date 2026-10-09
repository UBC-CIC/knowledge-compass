/**
 * Anonymous user identity and API access tokens.
 *
 * POST /user returns a user id plus a long-lived credential. Both are kept in
 * localStorage; the credential is exchanged at /user/publicToken for 15-minute
 * access tokens bound to that user, which user and session routes require.
 * Without a credential, /user/publicToken returns an anonymous token that can
 * only create a user and read public settings.
 */

const STORAGE_KEY = "knowledgeCompass_user_session";
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
  const response = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`, {
    headers: credential ? { Authorization: `Bearer ${credential}` } : undefined,
  });
  if (response.status === 401 && credential) {
    clearUserSession();
    throw new CredentialRejectedError();
  }
  if (!response.ok) throw new Error("Failed to get public token");
  const { token } = (await response.json()) as { token?: string };
  if (!token) throw new Error("Public token response missing token");
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
      cached = { credential, token, fetchedAt: Date.now() };
      return token;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { credential, promise };
  return promise;
}
