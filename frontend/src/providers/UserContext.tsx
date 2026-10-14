import { useEffect, useState } from "react";
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


export function UserProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(isDemoMode ? DEMO_USER_ID : null);
  const [isLoading, setIsLoading] = useState(!isDemoMode);
  const [error, setError] = useState<Error | null>(null);

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
          throw new Error("Failed to create user");
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
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to create user"));
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
        setError(e instanceof Error ? e : new Error("Failed to initialize user"));
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

  return (
    <UserContext.Provider value={{ userId, isLoading, error }}>
      {children}
    </UserContext.Provider>
  );
}
