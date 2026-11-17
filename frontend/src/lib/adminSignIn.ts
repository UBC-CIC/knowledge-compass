// Helpers for the admin sign-in steps (pages/Admin/AdminLogin.tsx).
// The admin Cognito pool allows TOTP (authenticator app) MFA and, when SES is
// configured, email MFA; see the UserPool in cdk/lib/api-stack.ts.

export type AdminSignInStep =
  | "credentials"
  | "newPassword"
  | "totpSetup"
  | "totpCode"
  | "mfaSelection"
  | "emailSetup"
  | "emailCode";

// Issuer shown in the authenticator app next to the admin's email.
export const TOTP_ISSUER = "Knowledge Compass";

/**
 * Maps an Amplify v6 `nextStep.signInStep` to what the admin login shows next:
 * "done" when signed in, a step to render, or null for a step this page does
 * not support (SMS is never enabled on the pool).
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
    case "CONTINUE_SIGN_IN_WITH_MFA_SELECTION":
    case "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION":
      return "mfaSelection";
    case "CONTINUE_SIGN_IN_WITH_EMAIL_SETUP":
      return "emailSetup";
    case "CONFIRM_SIGN_IN_WITH_EMAIL_CODE":
      return "emailCode";
    default:
      return null;
  }
}

/** Removes the spaces or dashes people type when copying a code (e.g. "123 456"). */
export function cleanTotpCode(input: string): string {
  return input.replace(/[\s-]/g, "");
}

/** Returns an error message for a cleaned code, or null when it is 6 digits. */
export function totpCodeError(
  code: string,
  source: "authenticator app" | "email" = "authenticator app"
): string | null {
  if (!code) {
    return `Enter the 6-digit code from ${source === "email" ? "the email" : "your authenticator app"}.`;
  }
  if (!/^\d{6}$/.test(code)) {
    return `The code should be 6 digits. Check ${source === "email" ? "your email" : "your authenticator app"} and try again.`;
  }
  return null;
}

/** Cognito MFA factor names offered on the selection step, as shown to admins. */
export const MFA_TYPE_LABELS: Record<string, string> = {
  TOTP: "Authenticator app",
  EMAIL: "Email",
};

/** Groups a shared secret in blocks of four so it is easier to type by hand. */
export function formatTotpSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

// Shown when Cognito accepted the sign-in but the account is not in the
// "admin" group, so the admin API authorizer refuses its token.
export const NOT_ADMIN_MESSAGE =
  "This account isn't an administrator. Ask an existing admin to add you, then sign in again.";

/**
 * True when an ID token's claims put the user in the Cognito "admin" group,
 * the only check the admin API authorizer makes (adminAuthorizerFunction.js).
 */
export function isAdminTokenPayload(payload: Record<string, unknown> | null | undefined): boolean {
  const groups = payload?.["cognito:groups"];
  return Array.isArray(groups) && groups.includes("admin");
}

/**
 * Message for a failed POST /admin/promote_user at the end of sign-in:
 * 401/403 mean the authorizer refused the account (not in the admin group).
 */
export function adminSetupErrorMessage(status: number | undefined): string {
  if (status === 401 || status === 403) return NOT_ADMIN_MESSAGE;
  return "We couldn't finish signing you in. Please try again.";
}
