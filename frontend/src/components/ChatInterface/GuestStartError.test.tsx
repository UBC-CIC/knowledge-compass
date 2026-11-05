import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GuestStartError from "./GuestStartError";

describe("GuestStartError", () => {
  it("shows the message as an alert with a retry button", () => {
    const html = renderToStaticMarkup(
      <GuestStartError message="Please wait a few minutes and try again." onRetry={() => {}} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Please wait a few minutes and try again.");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
  });
});
