import { spaSecurityHeaders } from "../lib/amplify-stack";

const origins = {
  restApiOrigin: "https://abc123.execute-api.ca-central-1.amazonaws.com",
  webSocketOrigin: "wss://def456.execute-api.ca-central-1.amazonaws.com",
  region: "ca-central-1",
};

const directives = (csp: string): Record<string, string[]> =>
  Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );

describe("spaSecurityHeaders", () => {
  const headers = spaSecurityHeaders(origins);

  test("sets the static hardening headers", () => {
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("microphone=()");
  });

  test("ships the CSP as Report-Only (decision D8)", () => {
    expect(headers["Content-Security-Policy-Report-Only"]).toBeDefined();
    expect(headers["Content-Security-Policy"]).toBeUndefined();
  });

  test("scripts are same-origin only and nothing can frame the app", () => {
    const csp = directives(headers["Content-Security-Policy-Report-Only"]);
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    for (const values of Object.values(csp)) {
      expect(values).not.toContain("'unsafe-eval'");
      expect(values).not.toContain("*");
    }
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
  });

  test("connect-src lists the APIs, Cognito and S3 uploads", () => {
    const csp = directives(headers["Content-Security-Policy-Report-Only"]);
    expect(csp["connect-src"]).toEqual([
      "'self'",
      origins.restApiOrigin,
      origins.webSocketOrigin,
      "https://cognito-idp.ca-central-1.amazonaws.com",
      "https://*.s3.ca-central-1.amazonaws.com",
    ]);
  });

  test("allows Google Fonts used by index.html", () => {
    const csp = directives(headers["Content-Security-Policy-Report-Only"]);
    expect(csp["style-src"]).toContain("https://fonts.googleapis.com");
    expect(csp["font-src"]).toContain("https://fonts.gstatic.com");
  });

  test("omits an empty WebSocket origin", () => {
    const csp = directives(spaSecurityHeaders({ ...origins, webSocketOrigin: "" })["Content-Security-Policy-Report-Only"]);
    expect(csp["connect-src"]).not.toContain("");
    expect(csp["connect-src"]).toHaveLength(4);
  });
});
