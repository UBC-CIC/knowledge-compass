/**
 * Staff sign-up email domains (the allow-list authorization/preSignUp.js
 * enforces), read from the SAME SSM parameter named by ALLOWED_EMAIL_DOMAINS.
 *
 * Guests may not claim an address in these domains through PUT /user, so a
 * guest row can never hold a staff address (finding f-23c5bf7c). Fails
 * closed: an unset variable, an empty value or an SSM error throws.
 */

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const CACHE_TTL_MS = 5 * 60 * 1000;
let ssmClient;
let cache = { domains: null, expiresAt: 0 };

async function loadStaffDomains() {
  if (cache.domains && Date.now() < cache.expiresAt) return cache.domains;
  const name = process.env.ALLOWED_EMAIL_DOMAINS;
  if (!name) throw new Error("ALLOWED_EMAIL_DOMAINS is not configured");
  if (!ssmClient) ssmClient = new SSMClient();
  const data = await ssmClient.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const domains = String(data?.Parameter?.Value || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0) throw new Error("ALLOWED_EMAIL_DOMAINS parameter is empty");
  cache = { domains, expiresAt: Date.now() + CACHE_TTL_MS };
  return domains;
}

/** True when the email's domain equals, or is a subdomain of, a staff domain. */
async function isStaffEmailDomain(email) {
  const domains = await loadStaffDomains();
  const at = typeof email === "string" ? email.lastIndexOf("@") : -1;
  const domain = at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  if (!domain) return false;
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

module.exports = { isStaffEmailDomain };
