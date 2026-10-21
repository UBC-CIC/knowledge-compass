"use strict";

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const {
  APIGatewayClient,
  GetStageCommand,
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

  const stage = await apigw.send(new GetStageCommand({ restApiId, stageName }));
  const variables = (stage && stage.variables) || {};
  const op = Object.prototype.hasOwnProperty.call(variables, variable) ? "replace" : "add";
  await apigw.send(
    new UpdateStageCommand({
      restApiId,
      stageName,
      patchOperations: [{ op, path: `/variables/${variable}`, value: origin }],
    }),
  );

  return { PhysicalResourceId: physicalId, Data: { origin } };
};
