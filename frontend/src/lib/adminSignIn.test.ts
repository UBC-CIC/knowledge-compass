import { describe, expect, it } from "vitest";
import {
  NOT_ADMIN_MESSAGE,
  adminSetupErrorMessage,
  adminStepFor,
  isAdminTokenPayload,
  cleanTotpCode,
  formatTotpSecret,
  totpCodeError,
} from "@/lib/adminSignIn";

describe("sign-in steps", () => {
  it("maps the Amplify v6 steps the admin pool can return", () => {
    expect(adminStepFor("DONE")).toBe("done");
    expect(adminStepFor("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED")).toBe("newPassword");
    expect(adminStepFor("CONTINUE_SIGN_IN_WITH_TOTP_SETUP")).toBe("totpSetup");
    expect(adminStepFor("CONFIRM_SIGN_IN_WITH_TOTP_CODE")).toBe("totpCode");
    expect(adminStepFor("CONTINUE_SIGN_IN_WITH_MFA_SELECTION")).toBe("mfaSelection");
    expect(adminStepFor("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION")).toBe("mfaSelection");
    expect(adminStepFor("CONTINUE_SIGN_IN_WITH_EMAIL_SETUP")).toBe("emailSetup");
    expect(adminStepFor("CONFIRM_SIGN_IN_WITH_EMAIL_CODE")).toBe("emailCode");
  });

  it("reports steps the page does not handle", () => {
    for (const step of [undefined, "", "CONFIRM_SIGN_IN_WITH_SMS_CODE", "CONFIRM_SIGN_UP"]) {
      expect(adminStepFor(step)).toBeNull();
    }
  });
});

describe("TOTP codes", () => {
  it("strips the spaces and dashes people type", () => {
    expect(cleanTotpCode(" 123 456 ")).toBe("123456");
    expect(cleanTotpCode("123-456")).toBe("123456");
  });

  it("accepts exactly six digits", () => {
    expect(totpCodeError("123456")).toBeNull();
    expect(totpCodeError("")).toMatch(/6-digit/);
    expect(totpCodeError("12345")).toMatch(/6 digits/);
    expect(totpCodeError("1234567")).toMatch(/6 digits/);
    expect(totpCodeError("12a456")).toMatch(/6 digits/);
    expect(totpCodeError("", "email")).toMatch(/the email/);
    expect(totpCodeError("12345", "email")).toMatch(/your email/);
  });

  it("groups the secret in blocks of four", () => {
    expect(formatTotpSecret("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
    expect(formatTotpSecret("ABCDEFGH")).toBe("ABCD EFGH");
  });
});

describe("admin group", () => {
  it("accepts only ID tokens in the admin group", () => {
    expect(isAdminTokenPayload({ "cognito:groups": ["admin"] })).toBe(true);
    expect(isAdminTokenPayload({ "cognito:groups": ["staff", "admin"] })).toBe(true);
    for (const payload of [undefined, null, {}, { "cognito:groups": [] }, { "cognito:groups": ["Admin"] }, { "cognito:groups": "admin" }]) {
      expect(isAdminTokenPayload(payload)).toBe(false);
    }
  });

  it("explains a refused account and keeps other failures generic", () => {
    expect(adminSetupErrorMessage(401)).toBe(NOT_ADMIN_MESSAGE);
    expect(adminSetupErrorMessage(403)).toBe(NOT_ADMIN_MESSAGE);
    for (const status of [undefined, 500, 502]) {
      expect(adminSetupErrorMessage(status)).not.toBe(NOT_ADMIN_MESSAGE);
    }
  });
});
