// Helpers for the admin sign-in steps (pages/Admin/AdminLogin.tsx).
// The admin Cognito pool allows TOTP (authenticator app) MFA only; see the
// UserPool in cdk/lib/api-stack.ts.

export type AdminSignInStep = "credentials" | "newPassword" | "totpSetup" | "totpCode";

// Issuer shown in the authenticator app next to the admin's email.
export const TOTP_ISSUER = "Knowledge Compass";

/**
 * Maps an Amplify v6 `nextStep.signInStep` to what the admin login shows next:
 * "done" when signed in, a step to render, or null for a step this page does
 * not support (the pool only enables TOTP, so SMS/email steps never occur).
 */
export function adminStepFor(
  signInStep: string | undefined
): Exclude<AdminSignInStep, "credentials"> | "done" | null {
  switch (signInStep) {
    case "DONE":
      return "done";
    case "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED":
      return "newPassword";
    case "CONTINUE_SIGN_IN_WITH_TOTP_SETUP":
      return "totpSetup";
    case "CONFIRM_SIGN_IN_WITH_TOTP_CODE":
      return "totpCode";
    default:
      return null;
  }
}

/** Removes the spaces or dashes people type when copying a code (e.g. "123 456"). */
export function cleanTotpCode(input: string): string {
  return input.replace(/[\s-]/g, "");
}

/** Returns an error message for a cleaned code, or null when it is 6 digits. */
export function totpCodeError(code: string): string | null {
  if (!code) return "Enter the 6-digit code from your authenticator app.";
  if (!/^\d{6}$/.test(code)) {
    return "The code should be 6 digits. Check your authenticator app and try again.";
  }
  return null;
}

/** Groups a shared secret in blocks of four so it is easier to type by hand. */
export function formatTotpSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}
