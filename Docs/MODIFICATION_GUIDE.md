# Knowledge Compass - Project Modification Guide

This guide covers practical modifications developers commonly need to make: styling, authentication, API extensions, frontend components, LLM configuration, database migrations, and deployment. For guardrail configuration, see `Docs/BEDROCK_GUARDRAILS.md`.

---

## Table of Contents

- [Modifying Colors and Styles](#modifying-colors-and-styles)
- [Admin & Public Token](#admin--public-token)
- [Using External Identity Providers (Enterprise SSO)](#using-external-identity-providers-enterprise-sso)
- [Extending the API](#extending-the-api)
- [Modifying Frontend Components](#modifying-frontend-components)
- [Configuring LLM Models](#configuring-llm-models)
- [Database Schema Changes (Migrations)](#database-schema-changes-migrations)
- [Message Limits](#message-limits)
- [Data Ingestion Modifications](#data-ingestion-modifications)
- [Deployment & Testing](#deployment--testing)
- [Encryption & KMS Keys](#encryption--kms-keys)
- [Troubleshooting & Best Practices](#troubleshooting--best-practices)

---

## Modifying Colors and Styles

The frontend uses Tailwind and CSS variables for theme colors. Primary variables are defined in `frontend/src/index.css`.

**Example** (change the primary brand color and sidebar background):

```css
/* frontend/src/index.css */
:root {
  --primary: rgb(23, 68, 103);
  --sidebar: rgb(23, 68, 103);
}
```

The `.dark` block overrides the same variables for dark mode.

For component-specific overrides, search for hex codes or Tailwind classes directly in `frontend/src/components/`.

---

## Admin & Public Token

The project uses a dual access model:

- **Admin users**: Authenticated via Cognito. Admin-only APIs require a Cognito token and are restricted by the admin authorizer in `OpenAPI_Swagger_Definition.yaml` and `cdk/lib/api-stack.ts`.
- **Public users**: no account. `POST /user` creates an anonymous user and returns a 30-day credential; the browser exchanges it at `GET /user/publicToken` (handled by `cdk/lambda/handlers/userHandler.js`) for 15-minute access tokens bound to that user. The user authorizer verifies those tokens. The frontend keeps the credential in `localStorage` and refreshes tokens in `frontend/src/lib/publicToken.ts`.

Key files:
- `cdk/lib/api-stack.ts` — Cognito UserPool and API authorizer setup
- `cdk/lambda/handlers/userHandler.js` — anonymous user creation, credential rotation and public token minting
- `cdk/lambda/authorization/userAuthorizerFunction.js` — verifies public access tokens
- `cdk/lambda/adminAuthorizerFunction/adminAuthorizerFunction.js` — verifies the Cognito ID token and `admin` group
- `frontend/src/components/ProtectedRoute.tsx` — admin route protection

---

## Using External Identity Providers (Enterprise SSO)

Cognito supports federation with SAML 2.0 and OIDC providers (Okta, Azure AD, Keycloak, etc.), enabling SSO and centralized identity management.

- Configure an identity provider via the console or CDK (`CfnIdentityProvider`) and attach it to the user pool.
- Map attributes (e.g., email, groups) so application roles like `admin` are correctly assigned.
- Update redirect/callback URIs for the provider to include your Amplify/web app endpoints.

AWS docs:
- SAML: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html
- OIDC: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html

---

## Extending the API

The REST API is a `SpecRestApi` built from `cdk/OpenAPI_Swagger_Definition.yaml`. Routes, authorizers and integrations are defined in that file, not with `addResource`/`addMethod`. The integrations refer to each Lambda by a fixed logical ID, so a Lambda must never reference `this.api` (permissions, IAM, environment): CloudFormation treats that as a dependency cycle (see the comment above the `SpecRestApi` in `cdk/lib/api-stack.ts`). Follow `adminFunction` as the pattern.

1. Add the handler under `cdk/lambda/handlers/`, or add the route to an existing handler's router.
2. For a new function, define the `lambda.Function` in `cdk/lib/api-stack.ts` and pin its logical ID with `overrideLogicalId`.
3. In `cdk/OpenAPI_Swagger_Definition.yaml`, add the path with the matching `<<: *commonOptions<METHODS>` CORS block (one anchor per method set), a `security` entry (`adminAuthorizer` or `userAuthorizer`) and an `x-amazon-apigateway-integration` that points at the logical ID.
4. Grant API Gateway invoke with `addPermission`, using the wildcard API ID `sourceArn` pattern already used in `api-stack.ts`.
5. From `cdk/`, run `npm test` (includes `test/openapi-contract.test.ts`, which checks every handler route is reachable through the definition) and `npx cdk synth`.

```typescript
// cdk/lib/api-stack.ts
const myFunction = new lambda.Function(this, `${id}-myFunction`, {
  runtime: lambda.Runtime.NODEJS_22_X,
  code: lambda.Code.fromAsset("lambda"),
  handler: "handlers/myHandler.handler",
  // vpc, environment, layers, role: copy from lambdaAdminFunction
});
myFunction.addPermission("AllowApiGatewayInvoke", {
  principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
  action: "lambda:InvokeFunction",
  sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/*/admin/my-feature*`,
});
(myFunction.node.defaultChild as lambda.CfnFunction).overrideLogicalId("myFunction");
```

```yaml
# cdk/OpenAPI_Swagger_Definition.yaml
  /admin/my-feature:
    <<: *commonOptionsPOST
    post:
      security:
        - adminAuthorizer: []
      responses:
        "200":
          description: OK
      x-amazon-apigateway-integration:
        uri:
          Fn::Sub: arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${myFunction.Arn}/invocations
        passthroughBehavior: "when_no_match"
        httpMethod: POST
        type: aws_proxy
```

The function also needs `ALLOWED_ORIGIN_PARAM` and the matching `ssm:GetParameter` grant for CORS, as every existing API function has. Document the route in [`API_DOCUMENTATION.md`](./API_DOCUMENTATION.md).

---

## Modifying Frontend Components

Frontend code is in `frontend/src/`:
- `pages/` — route-level pages
- `components/` — reusable UI blocks
- `providers/` — React context (`UserContext`, `ViewContext`, `SidebarContext`)
- `lib/` — API client, public token handling and other helpers

### Adding a new page

```tsx
// frontend/src/pages/NewFeature/NewFeature.tsx
export default function NewFeature() {
  return <div>New Feature page</div>;
}

// frontend/src/App.tsx
import NewFeature from "./pages/NewFeature/NewFeature";
<Route path="/new-feature" element={<NewFeature />} />
```

Wrap with `<ProtectedRoute>` if admin-only.

---

## Configuring LLM Models

The text generation Lambda reads two model IDs from SSM: `HaikuArn` (router, detective replies, grounding check, titles) and `SonnetArn` (partial and suggestion replies). Both are set to Claude Haiku 5.5 (`us.anthropic.claude-haiku-5-5`):

- `/KC/LLM/HaikuArn`
- `/KC/LLM/SonnetArn`

To update a model, change the SSM parameter value via the AWS Console or CLI:

```bash
aws ssm put-parameter \
  --name "/KC/LLM/HaikuArn" \
  --value "us.anthropic.claude-haiku-5-5" \
  --type String \
  --overwrite
```

**Rules when updating:**
- All ARNs must use the `us.` cross-region inference prefix (e.g., `us.anthropic.claude-...`).
- Every generation call sends `thinking: {"type": "disabled"}` and no `temperature`/`top_p` (Haiku 5.5 returns a 400 for non-default sampling values). A model that needs different request fields needs a code change, not only a parameter change.
- The admin `temperature` and `top_p` settings are stored but not sent to Bedrock.

> **Note:** If you switch to a different model family, you'll also need to update the IAM policy on the `lambdaTextGen` role to allow `bedrock:InvokeModel` for the new model ARN. This is configured in `cdk/lib/api-stack.ts` under `textGenBedrockPolicyStatement`.

For guardrail configuration, see `Docs/BEDROCK_GUARDRAILS.md`.

---

## Database Schema Changes (Migrations)

Migrations live in `cdk/lambda/db_setup/migrations/`, run with `node-pg-migrate` by the DBFlow stack, and follow a three-digit numbered naming convention. Add the next number after the newest file; never edit a migration that has already been deployed.

```javascript
// cdk/lambda/db_setup/migrations/050_add_new_feature_table.js
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS new_feature (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      name text NOT NULL,
      description text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS new_feature;`);
};
```

See [`DATABASE_MIGRATIONS.md`](./DATABASE_MIGRATIONS.md) for the full workflow.

---

## Message Limits

These limits are admin settings in `system_settings` (dashboard: [General Settings](./USER_GUIDE.md#general-settings)); changes apply without a deploy:

- `max_characters_per_user_message`: length of one message
- `max_characters_per_day` and `max_messages_per_day`: per user, per UTC day
- `max_messages_per_day_global`: all public users together, per UTC day
- `max_characters_per_ai_message`: length of an answer

The daily cap of 20 new chat sessions per user is a constant (`DAILY_SESSION_LIMIT` in `cdk/lambda/handlers/chatSessionHandler.js`), not a setting.

---

## Data Ingestion Modifications

Ingestion has two parts:

- `cdk/lambda/knowledgeBase/` (Python Lambda) handles the admin API, uploads, documents (PDF, DOCX, CSV, Markdown, JSON), embedding-space management, and launches the container tasks. To add a file type or change chunking, modify `main.py` and the `helpers/` modules.
- `cdk/containers/crawler/` and `cdk/containers/transcriber/` run on ECS Fargate for websites and videos. Changes are rebuilt and deployed by CodePipeline.

Code shared by both Python Lambdas (CORS, embeddings, retrieval) lives in the `kc_shared` layer at `cdk/layers/shared_python/`. Add a DB migration if new metadata tables are needed. See [`KNOWLEDGE_BASE_DOCUMENTATION.md`](./KNOWLEDGE_BASE_DOCUMENTATION.md).

---

## Deployment & Testing

**CDK / Backend:**
```bash
cd cdk
npm ci
npm run build
npm test             # CDK Jest tests (cdk/test)
npm run test:lambda  # Node Lambda tests (lambda/**/tests/*.test.js)
npx cdk deploy --all -c StackPrefix=<PREFIX> -c githubRepo=<REPO> --profile <PROFILE>
```

See the [Deployment Guide](./DEPLOYMENT_GUIDE.md#deploy-the-stacks) for the full deploy command and context flags.

**Python Lambda dependencies:**
Python Lambdas (`textGeneration`, `knowledgeBase`) do not auto-install `requirements.txt` at deploy time — dependencies are either vendored into the Lambda folder or come from Lambda layers. See [`DEPENDENCY_MANAGEMENT.MD`](./DEPENDENCY_MANAGEMENT.MD) before adding one.

**Frontend:**
```bash
cd frontend
npm ci
npm run build   # type-check and production build
npm run lint
```

Run the dev server manually with `npm run dev` (Vite).

**CI/CD:** See `Docs/DEPLOYMENT_GUIDE.md` for pipeline specifics.

---

## Encryption & KMS Keys

Most resources use AWS managed keys (S3 buckets use SSE-S3); the API Gateway and WAF log groups use a customer-managed key. To switch other resources to customer-managed keys, see [`AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md).

---

## Troubleshooting & Best Practices

- **Lambda Timeout**: Increase `timeout` in the CDK function definition.
- **Memory/Latency**: Increase `memorySize`; check VPC and RDS proxy config.
- **Database**: Verify `SM_DB_CREDENTIALS` in Secrets Manager and RDS proxy endpoint.
- **Cognito**: Check the user pool and client IDs in `frontend/.env.local` (local development) or the Amplify environment variables (see [`frontend/README.md`](../frontend/README.md)).
- **Guardrails**: See `Docs/BEDROCK_GUARDRAILS.md` for topic policies, allow rules, and testing.
- **Logging**: CloudWatch logs are the primary debugging source for all Lambdas.
