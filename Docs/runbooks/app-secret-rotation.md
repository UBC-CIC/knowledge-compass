# Runbook: rotating the application secrets

Knowledge Compass signs and checks three of its own secrets. Secrets Manager rotates each one every 90 days, and nobody has to do anything for a scheduled rotation. This runbook covers what rotation does, how to rotate by hand, and how to revoke a leaked key.

## The secrets

| Secret (Secrets Manager name) | What it protects | Key field | Previous-key field |
|---|---|---|---|
| `<prefix>-Api-KC-JWTSecret` | Guest credentials (30 days) and access tokens (15 minutes): the user authorizer, the WebSocket API and `GET /user/publicToken` | `jwtSecret` | `previousJwtSecret` |
| `<prefix>-Api-KC-WorkerInvokeSecret` | Self-invocations of the knowledge-base Lambda, which rewrite the content index | `token` | `previousToken` |
| `<prefix>/eval/signing-secret` (only if the Eval stack is deployed) | Evaluation-harness session tags | `signingKey` | `previousSigningKey` |

`<prefix>` is the stack prefix the app was deployed with.

The database credentials are rotated separately, every 30 days (`cdk/lib/database-stack.ts`).

## How rotation works

The rotation function (`cdk/lambda/appSecretRotation`) generates a new key and keeps the old one as the previous key. Tokens are always signed with the current key. Every check accepts the current key or the previous one.

- A scheduled rotation logs nobody out. A guest credential signed just before a rotation is still accepted until it expires (30 days), and 90 days between rotations is longer than that.
- After a rotation, checks running on a warm Lambda pick up the new key within 5 minutes. A token signed with a key they have not seen yet makes them re-read the secret (at most every 30 seconds).
- Deploying never starts a rotation (`rotateImmediatelyOnUpdate: false`). A rotation only runs on its schedule or when you start it.

## Rotate by hand

AWS console: Secrets Manager → the secret → **Rotation** → **Rotate secret immediately**.

CLI:

```
aws secretsmanager rotate-secret --secret-id <secret name>
```

Check that it finished: the secret's newest version has the `AWSCURRENT` label, and the rotation function's log group (`/aws/lambda/<prefix>-Api-AppSecretRotation`) shows the four steps `createSecret`, `setSecret`, `testSecret` and `finishSecret` without errors.

## Revoke a leaked key

One rotation is not enough: the leaked key becomes the previous key and is still accepted.

1. Rotate the secret.
2. Wait for the first rotation to finish, then rotate it again. The leaked key is now gone.

What users notice:

- **JWT secret.** A guest whose credential was signed with the leaked key is treated as a new visitor and can no longer open their earlier conversations. Use this only for a real leak. To revoke one user's credentials, bump `users.credential_version` instead.
- **Worker invoke token.** Background jobs in flight during the second rotation can fail; retry them from the admin console.
- **Eval signing key.** Running evaluation jobs create untagged sessions until they are restarted.
