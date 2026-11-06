import { beforeEach, describe, expect, it, vi } from "vitest";

// Browser-like local and session storage, in place before Amplify picks its
// storage backends when it is imported.
const { local, session } = vi.hoisted(() => {
  const memory = (): Storage => {
    const items = new Map<string, string>();
    return {
      get length() {
        return items.size;
      },
      clear: () => items.clear(),
      getItem: (key: string) => items.get(key) ?? null,
      key: (index: number) => [...items.keys()][index] ?? null,
      removeItem: (key: string) => {
        items.delete(key);
      },
      setItem: (key: string, value: string) => {
        items.set(key, String(value));
      },
    };
  };
  const local = memory();
  const session = memory();
  vi.stubGlobal("window", { localStorage: local, sessionStorage: session });
  return { local, session };
});

// Stands in for Cognito: a completed SRP sign-in hands its tokens to the
// configured token store, as Amplify's signIn does.
vi.mock("aws-amplify/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("aws-amplify/auth")>();
  const token = (raw: string) => ({ payload: {}, toString: () => raw });
  return {
    ...actual,
    signIn: vi.fn(async () => {
      const { cognitoUserPoolsTokenProvider } = await import("aws-amplify/auth/cognito");
      await cognitoUserPoolsTokenProvider.authTokenStore.storeTokens({
        accessToken: token("access.jwt.sig"),
        idToken: token("id.jwt.sig"),
        refreshToken: "refresh-token",
        clockDrift: 0,
        username: "admin-sub",
      });
      return { isSignedIn: true, nextStep: { signInStep: "DONE" } };
    }),
  };
});

import { Amplify } from "aws-amplify";
import { signIn } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { defaultStorage } from "aws-amplify/utils";
import { AuthService } from "./authService.js";

Amplify.configure({
  Auth: { Cognito: { userPoolClientId: "test-client", userPoolId: "ca-central-1_test" } },
});

const cognitoKeys = (storage: Storage) =>
  Array.from({ length: storage.length }, (_, i) => storage.key(i) ?? "").filter((key) =>
    key.startsWith("CognitoIdentityServiceProvider.")
  );
const ACCESS_TOKEN_KEY = "CognitoIdentityServiceProvider.test-client.admin-sub.accessToken";
const REFRESH_TOKEN_KEY = "CognitoIdentityServiceProvider.test-client.admin-sub.refreshToken";

describe('AuthService.signIn and "Keep me signed in" (f-972599ea)', () => {
  beforeEach(() => {
    local.clear();
    session.clear();
    // A fresh page load: Amplify.configure starts on localStorage.
    cognitoUserPoolsTokenProvider.setKeyValueStorage(defaultStorage);
    vi.mocked(signIn).mockClear();
  });

  it("an unticked box keeps the Cognito tokens out of localStorage", async () => {
    const result = await AuthService.signIn("admin@example.org", "pw", false);

    expect(result.success).toBe(true);
    expect(signIn).toHaveBeenCalledOnce();
    expect(cognitoKeys(local)).toEqual([]);
    expect(session.getItem(ACCESS_TOKEN_KEY)).toBe("access.jwt.sig");
    expect(session.getItem(REFRESH_TOKEN_KEY)).toBe("refresh-token");
  });

  it("a ticked box keeps the tokens in localStorage, as before", async () => {
    const result = await AuthService.signIn("admin@example.org", "pw", true);

    expect(result.success).toBe(true);
    expect(local.getItem(ACCESS_TOKEN_KEY)).toBe("access.jwt.sig");
    expect(local.getItem(REFRESH_TOKEN_KEY)).toBe("refresh-token");
    expect(cognitoKeys(session)).toEqual([]);
  });

  it("a caller that passes no choice keeps the tokens in localStorage", async () => {
    await AuthService.signIn("admin@example.org", "pw", false);
    local.clear();
    session.clear();

    await AuthService.signIn("admin@example.org", "pw");

    expect(local.getItem(ACCESS_TOKEN_KEY)).toBe("access.jwt.sig");
    expect(cognitoKeys(session)).toEqual([]);
  });

  it("still pins SRP", async () => {
    await AuthService.signIn("admin@example.org", "pw", false);

    expect(signIn).toHaveBeenCalledWith({
      username: "admin@example.org",
      password: "pw",
      options: { authFlowType: "USER_SRP_AUTH" },
    });
  });
});
