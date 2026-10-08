import { describe, expect, it } from "vitest";
import { trimTrailingSlashes } from "@/lib/api";

describe("trimTrailingSlashes", () => {
  it("removes a trailing slash", () => {
    expect(trimTrailingSlashes("https://abc.execute-api.ca-central-1.amazonaws.com/prod/")).toBe(
      "https://abc.execute-api.ca-central-1.amazonaws.com/prod",
    );
  });

  it("removes multiple trailing slashes", () => {
    expect(trimTrailingSlashes("https://example.com/prod///")).toBe("https://example.com/prod");
  });

  it("leaves a URL without a trailing slash unchanged", () => {
    expect(trimTrailingSlashes("https://example.com/prod")).toBe("https://example.com/prod");
  });

  it("leaves an empty string unchanged", () => {
    expect(trimTrailingSlashes("")).toBe("");
  });
});
