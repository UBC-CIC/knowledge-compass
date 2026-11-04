/**
 * ingestion-stack.ts
 *
 * pgvector ingestion infrastructure (item R2; see
 * Docs/PGVECTOR_MIGRATION_PLAN.md).
 *
 * Creates the ECS Fargate cluster + task definitions that run the containerized
 * web crawler and video transcriber, writing directly into the unified
 * sources/chunks tables (pgvector). The admin ingestion Lambda
 * (lambdaKnowledgeBase) launches these tasks via ecs:RunTask (see
 * cdk/lambda/knowledgeBase/helpers/process_crawler_batch.py).
 *
 * The container images are built by the existing CICD pipeline (cicd-stack.ts):
 * add "crawler" and "transcriber" entries to the lambdaFunctions array in
 * cdk/bin/cdk.ts (sourceDir pointing at the Dockerfile), then pass the resulting
 * ECR repositories into this stack.
 *
 * ⚠️ SYNTH-PENDING: This stack has been type-checked (tsc) but NOT validated with
 * `cdk synth`/deploy against a live dev stack. Review IAM scoping, subnet/SG
 * wiring, RDS IAM-auth user setup, and image availability before deploying.
 */

import { Stack, StackProps, RemovalPolicy, Duration, CustomResource } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";

export interface IngestionStackProps extends StackProps {
  stackPrefix: string;
  crawlerRepository: ecr.IRepository;
  transcriberRepository: ecr.IRepository;
  // CodePipeline that builds the crawler/transcriber images (from CICDStack).
  // Used by the ECR image waiter to trigger a build if the image is missing.
  imageBuildPipelineName: string;
}

export class IngestionStack extends Stack {
  public readonly cluster: ecs.Cluster;
  public readonly crawlerTaskDef: ecs.FargateTaskDefinition;
  public readonly transcriberTaskDef: ecs.FargateTaskDefinition;
  public readonly ingestSecurityGroup: ec2.SecurityGroup;
  public readonly ingestBucket: s3.Bucket;
  public readonly transcribeDataAccessRole: iam.Role;

  // Container names must match what process_crawler_batch.py overrides.
  public readonly crawlerContainerName = "crawler";
  public readonly transcriberContainerName = "transcriber";

  private readonly ingestSubnetIds: string;

  constructor(
    scope: Construct,
    id: string,
    vpcStack: VpcStack,
    db: DatabaseStack,
    props: IngestionStackProps
  ) {
    super(scope, id, props);

    // ── ECS cluster ──────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, `${id}-Cluster`, {
      vpc: vpcStack.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Private subnets (with egress) the awsvpc tasks run in. Resolved from the VPC.
    this.ingestSubnetIds = vpcStack.vpc
      .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
      .subnetIds.join(",");

    // ── Security group for ingestion tasks ─────────────────────────────────────
    // Outbound HTTPS (Bedrock/S3/Secrets Manager) + Postgres to the DB/RDS Proxy.
    // DNS is required: allowAllOutbound=false otherwise blocks AmazonProvidedDNS
    // (VPC CIDR + 2), so the task cannot resolve RDS Proxy / S3 / Bedrock and
    // dies while the admin row stays 'running'.
    this.ingestSecurityGroup = new ec2.SecurityGroup(this, `${id}-TaskSg`, {
      vpc: vpcStack.vpc,
      description: "Security group for pgvector ingestion Fargate tasks",
      allowAllOutbound: false,
    });
    this.ingestSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Outbound HTTPS (Bedrock/S3/SecretsManager)");
    this.ingestSecurityGroup.addEgressRule(ec2.Peer.ipv4(vpcStack.vpcCidrString), ec2.Port.tcp(5432), "Postgres to RDS/RDS Proxy within VPC");
    this.ingestSecurityGroup.addEgressRule(ec2.Peer.ipv4(vpcStack.vpcCidrString), ec2.Port.udp(53), "DNS UDP (AmazonProvidedDNS)");
    this.ingestSecurityGroup.addEgressRule(ec2.Peer.ipv4(vpcStack.vpcCidrString), ec2.Port.tcp(53), "DNS TCP fallback");

    // ── S3 ingest bucket (uploads, transcript outputs, Textract artifacts) ────
    // DESTROY + autoDeleteObjects on purpose: uploaded content must not outlive the
    // deployment. See "Ingest buckets are deleted with the stack" in
    // Docs/SECURITY_OVERVIEW.md section 9.1 before changing this to RETAIN.
    const accessLogsBucket = new s3.Bucket(this, `${id}-IngestAccessLogs`, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      versioned: true,
    });

    this.ingestBucket = new s3.Bucket(this, `${id}-IngestBucket`, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "ingest-access-logs/",
      // Versioning keeps deleted/overwritten uploads as noncurrent versions;
      // expire them so admin deletes actually free storage.
      lifecycleRules: [
        {
          id: "ExpireNoncurrentVersions",
          noncurrentVersionExpiration: Duration.days(3),
          expiredObjectDeleteMarker: true,
          abortIncompleteMultipartUploadAfter: Duration.days(3),
        },
        {
          // Textract staging copies of fetched PDFs (deleted once read) and
          // cached OCR text (lambda/knowledgeBase/helpers/pdf_text.py). This
          // bounds how long extracted text outlives its source; an expired
          // cache entry only means that PDF is OCR'd again on its next sync.
          id: "ExpireTextractArtifacts",
          prefix: "textract/",
          expiration: Duration.days(30),
        },
      ],
    });

    // ── Shared task/execution role setup ───────────────────────────────────────
    // Execution role: pull image from ECR + write logs.
    const executionRole = new iam.Role(this, `${id}-TaskExecRole`, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });

    const region = this.region;
    const account = this.account;
    // Embedding models the ingestion tasks may invoke. Which model is actually
    // used is configuration on the embedding_spaces row (read from the DB at
    // runtime), not task-definition env. The candidate grants below only enable
    // those models; they do not assert availability in this region.
    // Foundation-model ARNs for candidates use a wildcard region because a
    // cross-region inference profile invokes the model in a destination region.
    // Manually built ARNs on purpose (no CDK token references).
    const embeddingModelArns = [
      `arn:aws:bedrock:${region}::foundation-model/cohere.embed-english-v3`,
      // Amazon Titan Text Embeddings V2
      `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`,
      `arn:aws:bedrock:${region}:${account}:inference-profile/*amazon.titan-embed-text-v2*`,
      // Cohere Embed v4 (model id suffix not verified: grant both forms)
      `arn:aws:bedrock:*::foundation-model/cohere.embed-v4`,
      `arn:aws:bedrock:*::foundation-model/cohere.embed-v4:0`,
      `arn:aws:bedrock:${region}:${account}:inference-profile/*cohere.embed-v4*`,
    ];

    // Task role: what the container code (crawler/transcriber) may do at runtime.
    const makeTaskRole = (name: string, includeS3Read: boolean): iam.Role => {
      const role = new iam.Role(this, name, {
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        description: "Runtime role for a pgvector ingestion Fargate task",
      });
      // Cohere embeddings via Bedrock.
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: embeddingModelArns,
      }));
      // No rds-db:connect (A-08). The containers reach the DB through RDS Proxy,
      // which takes no IAM tokens, and process_crawler_batch.py forces
      // DB_AUTH=secret on every RunTask. The secret below is the only DB credential.
      // Read the DB credentials secret.
      db.secretPathUser.grantRead(role);
      // Logs.
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["arn:aws:logs:*:*:*"],
      }));
      if (includeS3Read) {
        // Transcriber reads the Transcribe output JSON from the ingest bucket.
        this.ingestBucket.grantRead(role);
      }
      return role;
    };

    const crawlerTaskRole = makeTaskRole(`${id}-CrawlerTaskRole`, false);
    const transcriberTaskRole = makeTaskRole(`${id}-TranscriberTaskRole`, true);

    // Keep these env vars stable. Changing an ECS task definition replaces the
    // resource and updates KC-Ingestion's task-def ARN export, which CloudFormation
    // refuses while KC-Api still imports it. Secret DB auth is injected at RunTask
    // time in process_crawler_batch.py (overrides DB_AUTH=iam below; the task
    // roles have no rds-db:connect, so IAM auth would fail if the override were lost).
    const containerDbEnv: { [key: string]: string } = {
      DB_HOST: db.rdsProxyEndpoint,
      DB_NAME: "KC",
      DB_USER: "app_rw",
      DB_AUTH: "iam",
      AWS_REGION: region,
    };

    this.transcribeDataAccessRole = new iam.Role(this, `${id}-TranscribeAccessRole`, {
      assumedBy: new iam.ServicePrincipal("transcribe.amazonaws.com"),
      description: "Lets Amazon Transcribe read uploaded videos and write transcript JSON",
    });
    this.ingestBucket.grantReadWrite(this.transcribeDataAccessRole);

    // ── ECR image waiter ───────────────────────────────────────────────────────
    // The crawler/transcriber images are built by the CICD pipeline, so on a first
    // deploy they may not exist yet when this stack resolves the task-def images.
    // Reuse the same waiter Lambda the KB stack uses: it polls ECR for the :latest
    // image and triggers the pipeline build if missing. One CustomResource per repo.
    const imageWaiterRole = new iam.Role(this, `${id}-EcrImageWaiterRole`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    imageWaiterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ecr:DescribeImages", "ecr:DescribeRepositories", "ecr:BatchGetImage"],
      resources: [props.crawlerRepository.repositoryArn, props.transcriberRepository.repositoryArn],
    }));
    imageWaiterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["codepipeline:StartPipelineExecution"],
      resources: [`arn:aws:codepipeline:${this.region}:${this.account}:${props.imageBuildPipelineName}`],
    }));
    imageWaiterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: ["arn:aws:logs:*:*:*"],
    }));

    const imageWaiterFn = new lambda.Function(this, `${id}-EcrImageWaiterFn`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      role: imageWaiterRole,
      timeout: Duration.minutes(15),
      code: lambda.Code.fromAsset("lambda/ecrImageWaiter"),
    });

    const makeImageWaiter = (label: string, repo: ecr.IRepository): CustomResource =>
      new CustomResource(this, `${id}-EcrImageWaiter-${label}`, {
        serviceToken: imageWaiterFn.functionArn,
        properties: {
          RepositoryName: repo.repositoryName,
          ImageTag: "latest",
          MaxRetries: "28",
          RetryDelaySeconds: "30",
          CodePipelineName: props.imageBuildPipelineName,
          TriggerBuildOnMissing: "true",
        },
      });

    const crawlerImageWaiter = makeImageWaiter("Crawler", props.crawlerRepository);
    const transcriberImageWaiter = makeImageWaiter("Transcriber", props.transcriberRepository);

    // ── Crawler task definition ────────────────────────────────────────────────
    // Playwright/Chromium needs more memory; give it a comfortable Fargate size.
    this.crawlerTaskDef = new ecs.FargateTaskDefinition(this, `${id}-CrawlerTaskDef`, {
      cpu: 1024,
      memoryLimitMiB: 4096,
      executionRole,
      taskRole: crawlerTaskRole,
    });
    this.crawlerTaskDef.addContainer(this.crawlerContainerName, {
      image: ecs.ContainerImage.fromEcrRepository(props.crawlerRepository, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "crawler",
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: containerDbEnv,
    });
    this.crawlerTaskDef.node.addDependency(crawlerImageWaiter);

    // ── Transcriber task definition ────────────────────────────────────────────
    this.transcriberTaskDef = new ecs.FargateTaskDefinition(this, `${id}-TranscriberTaskDef`, {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole: transcriberTaskRole,
    });
    this.transcriberTaskDef.addContainer(this.transcriberContainerName, {
      image: ecs.ContainerImage.fromEcrRepository(props.transcriberRepository, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "transcriber",
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: containerDbEnv,
    });
    this.transcriberTaskDef.node.addDependency(transcriberImageWaiter);

    // Keep EventBridge out of KC-Api: SpecRestApi already has a CloudFormation
    // cycle, and targeting that stack's Lambdas makes the changeset fail.
    const knowledgeBaseName = `${props.stackPrefix}-Api-lambdaKnowledgeBase`;
    const knowledgeBaseArn = `arn:aws:lambda:${this.region}:${this.account}:function:${knowledgeBaseName}`;
    // lambdaKnowledgeBase runs aws.transcribe / aws.ecs events only with the
    // worker invoke token (finding f-9d5748bc), which the relay adds. Name and
    // ARN are built by hand for the same reason as knowledgeBaseArn; they must
    // match the WorkerInvokeSecret in api-stack.ts (`${id}-KC-WorkerInvokeSecret`).
    const workerInvokeSecretName = `${props.stackPrefix}-Api-KC-WorkerInvokeSecret`;
    const transcribeRelay = new lambda.Function(this, "transcribeRelay", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/transcribeRelay"),
      timeout: Duration.seconds(30),
      memorySize: 128,
      environment: {
        TARGET_FUNCTION_NAME: knowledgeBaseName,
        WORKER_INVOKE_SECRET_NAME: workerInvokeSecretName,
      },
      functionName: `${id}-transcribeRelay`,
    });
    transcribeRelay.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [knowledgeBaseArn, `${knowledgeBaseArn}:*`],
      })
    );
    transcribeRelay.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${workerInvokeSecretName}-??????`,
        ],
      })
    );
    new events.Rule(this, "TranscribeComplete", {
      description: "Forward Amazon Transcribe job results to the knowledge-base Lambda",
      eventPattern: {
        source: ["aws.transcribe"],
        detailType: ["Transcribe Job State Change"],
        detail: {
          TranscriptionJobStatus: ["COMPLETED", "FAILED"],
        },
      },
      targets: [new targets.LambdaFunction(transcribeRelay)],
    });

    // If a Fargate task dies before it can UPDATE ingestion_runs, the admin row
    // stays 'running'. Fail that row when ECS reports the task STOPPED.
    new events.Rule(this, "IngestionTaskStopped", {
      description: "Forward stopped ingestion ECS tasks so stuck running rows can be failed",
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Task State Change"],
        detail: {
          lastStatus: ["STOPPED"],
          clusterArn: [this.cluster.clusterArn],
        },
      },
      targets: [new targets.LambdaFunction(transcribeRelay)],
    });
  }

  /**
   * Environment variables + IAM the admin ingestion Lambda (lambdaKnowledgeBase)
   * needs to launch these tasks. Call from the API stack once this stack is wired.
   */
  public grantRunTasks(principal: iam.IGrantable & { addToRolePolicy?: (s: iam.PolicyStatement) => void }): void {
    const runTaskStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ecs:RunTask"],
      resources: [
        this.crawlerTaskDef.taskDefinitionArn,
        this.transcriberTaskDef.taskDefinitionArn,
        this.cluster.clusterArn,
      ],
    });
    // DescribeTasks: handle_ecs_task_stopped re-reads a stopped task's state
    // from ECS instead of trusting the forwarded event.
    const taskStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ecs:TagResource", "ecs:DescribeTasks"],
      resources: [
        `arn:aws:ecs:${this.region}:${this.account}:task/${this.cluster.clusterName}/*`,
      ],
    });
    const passRoleStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["iam:PassRole"],
      resources: [
        this.crawlerTaskDef.taskRole.roleArn,
        this.transcriberTaskDef.taskRole.roleArn,
        this.crawlerTaskDef.executionRole!.roleArn,
        this.transcriberTaskDef.executionRole!.roleArn,
      ],
      conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
    });
    if (principal.addToRolePolicy) {
      principal.addToRolePolicy(runTaskStatement);
      principal.addToRolePolicy(taskStatement);
      principal.addToRolePolicy(passRoleStatement);
      principal.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "transcribe:StartTranscriptionJob",
            "transcribe:GetTranscriptionJob",
          ],
          resources: ["*"],
        })
      );
      principal.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["iam:PassRole"],
          resources: [this.transcribeDataAccessRole.roleArn],
          conditions: {
            StringEquals: { "iam:PassedToService": "transcribe.amazonaws.com" },
          },
        })
      );
    }
  }

  /** Env vars to set on lambdaKnowledgeBase so process_crawler_batch.py can run tasks. */
  public ingestionEnv(): { [key: string]: string } {
    return {
      // Keep the legacy env name used by generate_presigned_url*.py
      KNOWLEDGE_BASE_BUCKET_NAME: this.ingestBucket.bucketName,
      ECS_CLUSTER_ARN: this.cluster.clusterArn,
      CRAWLER_TASK_DEF_ARN: this.crawlerTaskDef.taskDefinitionArn,
      TRANSCRIBER_TASK_DEF_ARN: this.transcriberTaskDef.taskDefinitionArn,
      INGESTION_SUBNET_IDS: this.ingestSubnetIds,
      INGESTION_SECURITY_GROUP_IDS: this.ingestSecurityGroup.securityGroupId,
      CRAWLER_CONTAINER_NAME: this.crawlerContainerName,
      TRANSCRIBER_CONTAINER_NAME: this.transcriberContainerName,
      TRANSCRIBE_DATA_ACCESS_ROLE_ARN: this.transcribeDataAccessRole.roleArn,
      TRANSCRIBE_OUTPUT_PREFIX: "transcripts",
    };
  }
}
