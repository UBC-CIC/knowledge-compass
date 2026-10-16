import { describe, expect, it } from "vitest";
import {
  adminStepFor,
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
  });

  it("reports steps the page does not handle", () => {
    for (const step of [undefined, "", "CONFIRM_SIGN_IN_WITH_SMS_CODE", "CONTINUE_SIGN_IN_WITH_MFA_SELECTION", "CONFIRM_SIGN_UP"]) {
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
  });

  it("groups the secret in blocks of four", () => {
    expect(formatTotpSecret("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
    expect(formatTotpSecret("ABCDEFGH")).toBe("ABCD EFGH");
  });
});
