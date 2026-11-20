/**
 * The staff email domain allow-list (/KC/AllowedEmailDomains, a comma list).
 * One comparison for both enforcement points: the Cognito PreSignUp trigger
 * (preSignUp.js) and POST /admin/users (handlers/adminProvisioningHandler.js),
 * which must also check accounts that already exist, where no trigger runs
 * (finding f-87e4994d).
 *
 * Domains match exactly (no subdomains), trimmed and lower-cased on both sides.
 * An empty list allows nothing.
 */

/** The parameter value as a list of lower-cased domains, blanks dropped. */
const parseAllowedDomains = (value) =>
  String(value ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

/** True when the address has exactly one "@" and its domain is listed. */
const isAllowedEmailDomain = (email, allowedDomains) => {
  if (typeof email !== "string") return false;
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2 || !parts[1]) return false;
  return allowedDomains.includes(parts[1]);
};

module.exports = { parseAllowedDomains, isAllowedEmailDomain };
