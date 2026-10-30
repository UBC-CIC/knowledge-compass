# Knowledge Compass — CDK

AWS CDK (TypeScript) app for the Knowledge Compass backend: VPC, database and migrations, CI/CD, ingestion, APIs and Lambdas, Amplify hosting, cost alerts, and the optional evaluation stacks. `bin/cdk.ts` wires the stacks together; `lib/` holds one file per stack.

To deploy, follow the [Deployment Guide](../Docs/DEPLOYMENT_GUIDE.md); it lists the required secrets, SSM parameters and context flags (`StackPrefix`, `githubRepo`, `alarmEmail`, `monthlyBudgetUsd`, `enableReservedConcurrency`, `enableEval`).

## Layout

| Path | Contents |
|---|---|
| `bin/cdk.ts` | Stack wiring and context flags |
| `lib/` | Stack definitions |
| `lambda/` | Lambda sources (Node.js handlers and authorizers, Python text generation and knowledge base) |
| `layers/` | Lambda layers, including `shared_python` (`kc_shared`) |
| `containers/` | Crawler and transcriber images built by CodePipeline |
| `test/` | Jest contract tests for the synthesized stacks |
| `OpenAPI_Swagger_Definition.yaml` | REST API definition |

## Useful commands

* `npm run build` — compile TypeScript
* `npm run watch` — compile on change
* `npm test` — Jest contract tests (`test/`)
* `npm run test:lambda` — Node.js handler tests (`lambda/**/tests/*.test.js`)
* `npx cdk synth` — synthesize the CloudFormation templates
* `npx cdk diff` — compare deployed stacks with the current code
* `npx cdk deploy --all` — deploy every stack (see the Deployment Guide for the required context)

Python Lambda tests run from the function directory, for example `cd lambda/textGeneration && python -m unittest discover -s tests`.
