import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { UserContext } from "./user";
import { DEMO_USER_ID, isDemoMode } from "@/lib/demo";
import {
  CREDENTIAL_REJECTED_EVENT,
  clearUserSession,
  getPublicToken,
  readUserSession,
  saveUserSession,
} from "@/lib/publicToken";
import { API_ENDPOINT } from "@/lib/api";
import { GuestStartError, guestStartError, guestStartErrorFrom } from "@/lib/guestCreation";


export function UserProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(isDemoMode ? DEMO_USER_ID : null);
  const [isLoading, setIsLoading] = useState(!isDemoMode);
  const [error, setError] = useState<GuestStartError | null>(null);
  // The effect's shared createUser, so retry joins any creation in flight.
  const createUserRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (isDemoMode) {
      return;
    }

    // The stored credential must still buy a token for this user, and the
    // user must still exist.
    const validateUser = async (storedUserId: string) => {
      try {
        const token = await getPublicToken();
        const validateResp = await fetch(
          `${API_ENDPOINT}/user/${storedUserId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        return validateResp.ok;
      } catch (e) {
        console.error("Error validating user:", e);
        return false;
      }
    };

    // Bootstrap and the credential-rejected listener can both ask for a new
    // user at once; share one creation.
    let creating: Promise<void> | null = null;
    const createUser = () => {
      creating ??= createUserOnce().finally(() => {
        creating = null;
      });
      return creating;
    };
    createUserRef.current = createUser;

    const createUserOnce = async () => {
      try {
        // Without a stored credential this is an anonymous token, which may
        // only create a user.
        clearUserSession();
        const token = await getPublicToken();

        // Create an anonymous session user — guardians do not sign in.
        const response = await fetch(`${API_ENDPOINT}/user`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            role: "student",
            display_name: "Anonymous",
          }),
        });

        if (!response.ok) {
          throw await guestStartError(response);
        }

        const data = await response.json();

        const id = data.userId;
        const credential = data.credential;
        if (!id || !credential) {
          throw new Error("Create user response missing user id or credential");
        }

        saveUserSession({
          userId: id,
          credential,
          createdAt: new Date().toISOString(),
        });

        setUserId(id);
        setError(null);
      } catch (err) {
        console.error("Error creating user:", err);
        setError(guestStartErrorFrom(err));
      } finally {
        setIsLoading(false);
      }
    };

    const bootstrap = async () => {
      try {
        // Sessions saved before credentials existed read as null here, so
        // those browsers start a new anonymous user.
        const stored = readUserSession();
        if (stored && (await validateUser(stored.userId))) {
          setUserId(stored.userId);
          setIsLoading(false);
          return;
        }

        // create a new user only if none valid
        await createUser();
      } catch (e) {
        setError(guestStartErrorFrom(e));
        setIsLoading(false);
      }
    };

    bootstrap();

    // An expired or revoked credential can no longer act as this user; start
    // a new anonymous user rather than leaving every request failing.
    const onCredentialRejected = () => {
      setUserId(null);
      setIsLoading(true);
      void createUser();
    };
    window.addEventListener(CREDENTIAL_REJECTED_EVENT, onCredentialRejected);
    return () => window.removeEventListener(CREDENTIAL_REJECTED_EVENT, onCredentialRejected);
  }, []); // Only run once when the app starts

  const retry = () => {
    setError(null);
    setIsLoading(true);
    void createUserRef.current?.();
  };

  return (
    <UserContext.Provider value={{ userId, isLoading, error, retry }}>
      {children}
    </UserContext.Provider>
  );
}
