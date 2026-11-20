"use strict";

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const {
  APIGatewayClient,
  UpdateStageCommand,
} = require("@aws-sdk/client-api-gateway");
const { gatewayAllowOrigin } = require("./origin");

const ssm = new SSMClient({});
const apigw = new APIGatewayClient({});

// Copies the SPA origin from AllowedOrigins onto the REST stage variable that
// gateway error responses and OPTIONS mocks read. Runs on stack create/update.
exports.handler = async (event) => {
  const physicalId = event.PhysicalResourceId || "GatewayAllowedOrigin";
  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: physicalId };
  }

  const paramName = process.env.ALLOWED_ORIGINS_PARAM;
  const restApiId = process.env.REST_API_ID;
  const stageName = process.env.REST_API_STAGE;
  const variable = process.env.ALLOWED_ORIGIN_VARIABLE;
  const got = await ssm.send(new GetParameterCommand({ Name: paramName }));
  const origin = gatewayAllowOrigin(got.Parameter && got.Parameter.Value);

  // API Gateway's stage-variable PATCH model only accepts "replace" for
  // /variables/{name}; "add" is rejected even when the variable does not yet
  // exist, and "replace" creates it in that case. So always use "replace".
  await apigw.send(
    new UpdateStageCommand({
      restApiId,
      stageName,
      patchOperations: [
        { op: "replace", path: `/variables/${variable}`, value: origin },
      ],
    }),
  );

  return { PhysicalResourceId: physicalId, Data: { origin } };
};
