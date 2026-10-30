# AWS Managed Keys Usage

This document lists every place in the CDK infrastructure where an AWS managed key (rather than a customer-managed KMS key) is used for encryption, and describes exactly what code changes are required if you want to bring your own key (CMK).

---

## 1. RDS Instance — `cdk/lib/database-stack.ts`

**Current behaviour**

`storageEncrypted: true` is set on the `DatabaseInstance` construct without a `storageEncryptionKey` property. AWS therefore encrypts the RDS storage volume using the AWS managed key for RDS (`aws/rds`).

```ts
// cdk/lib/database-stack.ts
this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
  ...
  storageEncrypted: true, // uses aws/rds managed key
  ...
});
```

**To use a CMK**

1. Create (or import) a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const rdsKey = new kms.Key(this, "RdsEncryptionKey", {
     enableKeyRotation: true,
     description: "CMK for RDS storage encryption",
   });
   ```
2. Add the `storageEncryptionKey` property to the `DatabaseInstance` definition:
   ```ts
   this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
     ...
     storageEncrypted: true,
     storageEncryptionKey: rdsKey, // add this line
     ...
   });
   ```
3. If Performance Insights is also required to use the same CMK, add:
   ```ts
   performanceInsightEncryptionKey: rdsKey,
   ```

---

## 2. S3 Ingest Buckets — `cdk/lib/ingestion-stack.ts`

**Current behaviour**

The ingest bucket (`${id}-IngestBucket`: uploaded files, Amazon Transcribe outputs, Textract staging copies) and its access-log bucket (`${id}-IngestAccessLogs`) are created without an `encryption` or `encryptionKey` property. CDK defaults to SSE-S3 (`AES256`), which uses the AWS managed key for S3 (`aws/s3`).

```ts
// cdk/lib/ingestion-stack.ts
const accessLogsBucket = new s3.Bucket(this, `${id}-IngestAccessLogs`, {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});

this.ingestBucket = new s3.Bucket(this, `${id}-IngestBucket`, {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const ingestKey = new kms.Key(this, "IngestS3Key", {
     enableKeyRotation: true,
     description: "CMK for the ingest S3 buckets",
   });
   ```
2. Add `encryption` and `encryptionKey` to both bucket definitions. The access-log bucket receives logs from the S3 logging service, which cannot write to a bucket encrypted with a CMK, so keep it on SSE-S3 unless your policy requires otherwise:
   ```ts
   this.ingestBucket = new s3.Bucket(this, `${id}-IngestBucket`, {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: ingestKey,
   });
   ```
3. The bucket's `grantRead`/`grantReadWrite` calls add the KMS permissions automatically for the roles they name: the crawler and transcriber task roles and the Amazon Transcribe data access role (`ingestion-stack.ts`), and `lambdaKnowledgeBase` through `grantBucketAccess` (`api-stack.ts`). Admin uploads use presigned URLs signed by `lambdaKnowledgeBase`, so they are covered by its grant. Amazon Textract reads PDFs with the caller's credentials, so it needs no separate grant.

---

## 3. S3 Buckets — `cdk/lib/cicd-stack.ts`

**Current behaviour**

Both `PipelineArtifactBucket` and `ArtifactAccessLogs` are created without an `encryption` or `encryptionKey` property. CDK defaults to SSE-S3 (`AES256`), which uses the AWS managed key for S3 (`aws/s3`).

```ts
// cdk/lib/cicd-stack.ts
const artifactAccessLogsBucket = new s3.Bucket(this, "ArtifactAccessLogs", {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});

const artifactBucket = new s3.Bucket(this, "PipelineArtifactBucket", {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const pipelineKey = new kms.Key(this, "PipelineArtifactKey", {
     enableKeyRotation: true,
     description: "CMK for CodePipeline artifact buckets",
   });
   ```
2. Add `encryption` and `encryptionKey` to both bucket definitions:
   ```ts
   const artifactAccessLogsBucket = new s3.Bucket(this, "ArtifactAccessLogs", {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: pipelineKey,
   });

   const artifactBucket = new s3.Bucket(this, "PipelineArtifactBucket", {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: pipelineKey,
   });
   ```
3. Grant the CodeBuild role and the CodePipeline service permission to use the key:
   ```ts
   pipelineKey.grantEncryptDecrypt(codeBuildRole);
   pipelineKey.grant(new iam.ServicePrincipal("codepipeline.amazonaws.com"), "kms:GenerateDataKey", "kms:Decrypt");
   ```

---

## 4. Secrets Manager Secrets — `cdk/lib/api-stack.ts`, `cdk/lib/database-stack.ts` and `cdk/lib/eval-stack.ts`

**Current behaviour**

All `secretsmanager.Secret` constructs are created without an `encryptionKey` property. Secrets Manager therefore encrypts them using the AWS managed key for Secrets Manager (`aws/secretsmanager`).

The affected secrets are:

| Secret | File | Variable |
|---|---|---|
| Cognito credentials | `api-stack.ts` | `this.secret` (`${id}-KC_Cognito_Secrets`) |
| JWT secret | `api-stack.ts` | `jwtSecret` (`${id}-KC-JWTSecret`) |
| Knowledge base worker invoke token | `api-stack.ts` | `workerInvokeSecret` (`${id}-KC-WorkerInvokeSecret`) |
| RDS admin credentials | `database-stack.ts` | generated by the `DatabaseInstance` (`this.dbInstance.secret`) |
| RDS application user credentials | `database-stack.ts` | `this.secretPathUser` |
| RDS table creator credentials | `database-stack.ts` | `this.secretPathTableCreator` |
| Evaluation signing key (only with `enableEval`) | `eval-stack.ts` | `this.signingSecret` |

```ts
// Example from api-stack.ts — same pattern applies to the other secrets
this.secret = new secretsmanager.Secret(this, secretsName, {
  secretName: secretsName,
  // no encryptionKey — uses aws/secretsmanager managed key
  ...
});
```

**To use a CMK**

1. Create a KMS key (one shared key or one per secret, depending on your policy requirements):
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const secretsKey = new kms.Key(this, "SecretsEncryptionKey", {
     enableKeyRotation: true,
     description: "CMK for Secrets Manager secrets",
   });
   ```
2. Add the `encryptionKey` property to each `secretsmanager.Secret` definition:
   ```ts
   this.secret = new secretsmanager.Secret(this, secretsName, {
     secretName: secretsName,
     encryptionKey: secretsKey, // add this line
     ...
   });
   ```
   For the RDS admin secret, pass `credentials: rds.Credentials.fromGeneratedSecret("<username>", { encryptionKey: secretsKey })` on the `DatabaseInstance`.
3. Any IAM role that calls `secretsmanager:GetSecretValue` on these secrets will also need `kms:Decrypt` on the key. The CDK `grantRead` helper on a secret automatically adds the required KMS permissions when an `encryptionKey` is set, so existing `grantRead` calls do not need to change. For roles that use inline `PolicyStatement` instead of `grantRead`, add:
   ```ts
   // once per role that reads a secret through an inline statement
   secretsKey.grantDecrypt(role);
   ```
4. The database secrets rotate through `HostedRotation` (`database-stack.ts`). CDK passes the secret's `encryptionKey` to the hosted rotation function automatically, so no extra grant is needed there.

---

## 5. Other Resources on AWS Managed or Default Keys

| Resource | File | Current encryption | To use a CMK |
|---|---|---|---|
| WebSocket connections table (DynamoDB) | `api-stack.ts` | `TableEncryption.AWS_MANAGED` (`aws/dynamodb`) | `encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED` + `encryptionKey` |
| Evaluation results and access-log buckets (only with `enableEval`) | `eval-stack.ts` | `BucketEncryption.S3_MANAGED` | `encryption: BucketEncryption.KMS` + `encryptionKey` on the results bucket |
| Crawler and transcriber ECR repositories | `cicd-stack.ts` | AES-256 (ECR default) | `encryption: ecr.RepositoryEncryption.KMS` + `encryptionKey` (repositories must be recreated) |
| Ops alarm and model lifecycle SNS topics | `api-stack.ts` | No server-side encryption | `masterKey` on the `sns.Topic`; the key policy must allow CloudWatch, Budgets and Cost Anomaly Detection to use it |

Already on a customer-managed key: the API Gateway access-log, WebSocket access-log and WAF log groups use `apiLogsKey` (`api-stack.ts`).

---

## Summary

| Resource | Stack file | AWS managed key used | Property to add for CMK |
|---|---|---|---|
| RDS instance storage | `database-stack.ts` | `aws/rds` | `storageEncryptionKey` on `DatabaseInstance` |
| S3 ingest buckets (×2) | `ingestion-stack.ts` | `aws/s3` (SSE-S3) | `encryption: BucketEncryption.KMS` + `encryptionKey` on the ingest bucket |
| S3 pipeline artifact buckets (×2) | `cicd-stack.ts` | `aws/s3` (SSE-S3) | `encryption: BucketEncryption.KMS` + `encryptionKey` on each `Bucket` |
| Secrets Manager secrets (×6, ×7 with evals) | `api-stack.ts`, `database-stack.ts`, `eval-stack.ts` | `aws/secretsmanager` | `encryptionKey` on each `Secret` |
| DynamoDB, eval buckets, ECR, SNS | see [section 5](#5-other-resources-on-aws-managed-or-default-keys) | AWS managed or service default | see section 5 |
