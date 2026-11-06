const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { parseAllowedDomains, isAllowedEmailDomain } = require("./emailDomains.js");

exports.handler = async (event) => {
  const ssmClient = new SSMClient();
  const parameterName = process.env.ALLOWED_EMAIL_DOMAINS;

  try {
    const getParameterCommand = new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    });
    const data = await ssmClient.send(getParameterCommand);
    const allowedDomains = parseAllowedDomains(data.Parameter.Value);
    const email = event.request.userAttributes.email;

    if (!isAllowedEmailDomain(email, allowedDomains)) {
      throw new Error(`Signup not allowed for email domain: ${String(email).split("@")[1]}`);
    }

    return event;
  } catch (error) {
    console.error(error);
    throw new Error("Error validating email domain during pre-signup.");
  }
};