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

import { Amplify } from "aws-amplify";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { defaultStorage, sessionStorage } from "aws-amplify/utils";
import {
  SESSION_ONLY_KEY,
  chooseAdminTokenStorage,
  isSessionOnly,
  restoreAdminTokenStorage,
} from "@/lib/adminTokenStorage";

Amplify.configure({
  Auth: { Cognito: { userPoolClientId: "test-client", userPoolId: "ca-central-1_test" } },
});

const tokenStore = cognitoUserPoolsTokenProvider.authTokenStore;

// An unsigned JWT is enough: the token store only decodes the payload.
const jwt = (payload: object) =>
  ["{}", JSON.stringify(payload)]
    .map((part) => btoa(part).replace(/=+$/, ""))
    .concat("sig")
    .join(".");
const ACCESS = jwt({ sub: "admin-sub", exp: 4102444800 });

// What a finished sign-in (SRP, new password or TOTP) writes.
const storeSignedInTokens = () =>
  tokenStore.storeTokens({
    accessToken: { payload: { sub: "admin-sub" }, toString: () => ACCESS },
    refreshToken: "refresh-token",
    clockDrift: 0,
    username: "admin-sub",
  });

const cognitoKeys = (storage: Storage) =>
  Array.from({ length: storage.length }, (_, i) => storage.key(i) ?? "").filter((key) =>
    key.startsWith("CognitoIdentityServiceProvider.")
  );

// A page load: Amplify.configure resets the store, then App.tsx restores it.
const reload = () => {
  cognitoUserPoolsTokenProvider.setKeyValueStorage(defaultStorage);
  restoreAdminTokenStorage();
};

describe('"Keep me signed in" token storage (f-972599ea)', () => {
  beforeEach(() => {
    local.clear();
    session.clear();
    cognitoUserPoolsTokenProvider.setKeyValueStorage(defaultStorage);
  });

  it("an unticked box keeps tokens in sessionStorage and nothing in localStorage", async () => {
    await chooseAdminTokenStorage(false);
    await storeSignedInTokens();

    expect(cognitoKeys(local)).toEqual([]);
    expect(cognitoKeys(session)).toContain(
      "CognitoIdentityServiceProvider.test-client.admin-sub.refreshToken"
    );
    expect(local.getItem(SESSION_ONLY_KEY)).toBe("1");
    expect(isSessionOnly()).toBe(true);
  });

  it("an unticked box clears tokens an earlier sign-in left in localStorage", async () => {
    await chooseAdminTokenStorage(true);
    await storeSignedInTokens();
    expect(cognitoKeys(local)).not.toEqual([]);

    await chooseAdminTokenStorage(false);

    expect(cognitoKeys(local)).toEqual([]);
  });

  it("an unticked box clears localStorage even when the tab already used sessionStorage", async () => {
    cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage);
    local.setItem("CognitoIdentityServiceProvider.test-client.LastAuthUser", "admin-sub");
    local.setItem("CognitoIdentityServiceProvider.test-client.admin-sub.refreshToken", "old");

    await chooseAdminTokenStorage(false);

    expect(cognitoKeys(local)).toEqual([]);
  });

  it("a reload of the tab finds the session-only tokens", async () => {
    await chooseAdminTokenStorage(false);
    await storeSignedInTokens();

    reload();

    expect(tokenStore.getKeyValueStorage()).toBe(sessionStorage);
    expect((await tokenStore.loadTokens())?.username).toBe("admin-sub");
  });

  it("a closed browser has no session left to restore", async () => {
    await chooseAdminTokenStorage(false);
    await storeSignedInTokens();

    session.clear(); // the browser ends the session's storage
    reload();

    expect(await tokenStore.loadTokens()).toBeNull();
  });

  it("a ticked box keeps tokens in localStorage, as before, and drops the marker", async () => {
    await chooseAdminTokenStorage(false);
    await storeSignedInTokens();

    await chooseAdminTokenStorage(true);
    await storeSignedInTokens();

    expect(cognitoKeys(session)).toEqual([]);
    expect(cognitoKeys(local)).toContain(
      "CognitoIdentityServiceProvider.test-client.admin-sub.refreshToken"
    );
    expect(local.getItem(SESSION_ONLY_KEY)).toBeNull();

    reload();
    expect(tokenStore.getKeyValueStorage()).toBe(defaultStorage);
    expect((await tokenStore.loadTokens())?.username).toBe("admin-sub");
  });

  it("without a stored choice a page load keeps Amplify's localStorage default", () => {
    reload();

    expect(isSessionOnly()).toBe(false);
    expect(tokenStore.getKeyValueStorage()).toBe(defaultStorage);
  });
});
