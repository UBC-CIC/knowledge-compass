import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { defaultStorage, sessionStorage } from "aws-amplify/utils";

// Where Amplify keeps the admin's Cognito tokens follows the "Keep me signed
// in" box: localStorage (Amplify's default) when ticked, sessionStorage when
// not, so the tokens end with the browser session (f-972599ea).
//
// This key holds no credential. It records an unticked box so a reload of the
// same tab looks for the tokens in sessionStorage. It lives in localStorage
// because it has to be readable before Amplify loads any tokens.
export const SESSION_ONLY_KEY = "kc-admin-session-only";

const markerStorage = (): Storage | null => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const isSessionOnly = (): boolean => {
  try {
    return markerStorage()?.getItem(SESSION_ONLY_KEY) === "1";
  } catch {
    return false;
  }
};

// Call once after Amplify.configure, which always resets the store to
// localStorage, and before anything reads the session.
export const restoreAdminTokenStorage = (): void => {
  if (isSessionOnly()) cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage);
};

// Call before signIn. The TOTP and new-password steps keep their state in
// Amplify's own sessionStorage keys, apart from the token store, so choosing
// the store here does not affect them; their tokens land in the chosen store.
export const chooseAdminTokenStorage = async (remember: boolean): Promise<void> => {
  const target = remember ? defaultStorage : sessionStorage;
  const other = remember ? sessionStorage : defaultStorage;
  try {
    // Drop any Cognito tokens left in the store not chosen, so an unticked
    // box leaves none in localStorage.
    cognitoUserPoolsTokenProvider.setKeyValueStorage(other);
    await cognitoUserPoolsTokenProvider.authTokenStore.clearTokens();
  } finally {
    cognitoUserPoolsTokenProvider.setKeyValueStorage(target);
  }

  const marker = markerStorage();
  if (!marker) return;
  if (remember) marker.removeItem(SESSION_ONLY_KEY);
  else marker.setItem(SESSION_ONLY_KEY, "1");
};
