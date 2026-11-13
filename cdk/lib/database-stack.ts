import { Stack, StackProps, RemovalPolicy, SecretValue } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";

import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";

import { VpcStack } from "./vpc-stack";

export class DatabaseStack extends Stack {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly secretPathAdminName: string;
  public readonly secretPathUser: secretsmanager.Secret;
  public readonly secretPathTableCreator: secretsmanager.Secret;
  public readonly rdsProxyEndpoint: string;

  constructor(
    scope: Construct,
    id: string,
    vpcStack: VpcStack,
    props?: StackProps
  ) {
    super(scope, id, props);

    const serviceLinkedRole = new cr.AwsCustomResource(
      this,
      `${id}-RDSServiceLinkedRoleResource`,
      {
      onCreate: {
        service: "IAM",
        action: "createServiceLinkedRole",
        parameters: {
          AWSServiceName: "rds.amazonaws.com",
        },
        ignoreErrorCodesMatching: "InvalidInput",
        physicalResourceId: cr.PhysicalResourceId.of("RDSServiceLinkedRole"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      }
    );
    /**
     * Retrieve a secret from Secret Manager
     */
    const secret = secretmanager.Secret.fromSecretNameV2(
      this,
      "ImportedSecrets",
      "KCSecrets"
    );

    /**
     * Create Secrets for various users
     */
    this.secretPathAdminName = `${id}-KC/credentials/rdsDbCredential`;
    const secretPathUserName = `${id}-KC/userCredentials/rdsDbCredential`;
    this.secretPathUser = new secretsmanager.Secret(this, secretPathUserName, {
      secretName: secretPathUserName,
      description: "Secrets for clients to connect to RDS",
      removalPolicy: RemovalPolicy.DESTROY,
      secretObjectValue: {
        username: SecretValue.unsafePlainText("applicationUsername"), // will be changed at runtime
        password: SecretValue.unsafePlainText("applicationPassword"), // will be changed at runtime
      },
    });

    const secretPathTableCreator = `${id}-KC/userCredentials/TableCreator`;
    this.secretPathTableCreator = new secretsmanager.Secret(
      this,
      secretPathTableCreator,
      {
        secretName: secretPathTableCreator,
        description: "Secrets for TableCreator to connect to RDS",
        removalPolicy: RemovalPolicy.DESTROY,
        secretObjectValue: {
          username: SecretValue.unsafePlainText("applicationUsername"), // will be changed at runtime
          password: SecretValue.unsafePlainText("applicationPassword"), // will be changed at runtime
        },
      }
    );

    // RDS retires old minor versions for new instances; keep this on a
    // version listed by `aws rds describe-db-engine-versions --engine postgres`.
    // 16.15 is newer than the constants in aws-cdk-lib 2.274.0, so use `of()`.
    const postgresVersion = rds.PostgresEngineVersion.of("16.15", "16");

    const parameterGroup = new rds.ParameterGroup(
      this,
      `${id}-rdsParameterGroup`,
      {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: postgresVersion,
        }),
        description: "Empty parameter group",
        parameters: {
          "rds.force_ssl": "1",
        },
      }
    );

    /**
     * Create the RDS Postgres database
     */
    this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
      vpc: vpcStack.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      engine: rds.DatabaseInstanceEngine.postgres({
        version: postgresVersion,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MEDIUM
      ),
      credentials: rds.Credentials.fromUsername(
        secret.secretValueFromJson("DB_Username").unsafeUnwrap(),
        {
          secretName: this.secretPathAdminName,
        }
      ),
      multiAz: false,
      allocatedStorage: 100,
      maxAllocatedStorage: 150,
      allowMajorVersionUpgrade: false,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      autoMinorVersionUpgrade: true,
      backupRetention: Duration.days(7),
      deleteAutomatedBackups: true,
      deletionProtection: true,
      databaseName: "KC",
      publiclyAccessible: false,
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
      storageEncrypted: true, // storage encryption at rest
      monitoringInterval: Duration.seconds(60), // enhanced monitoring interval
      parameterGroup: parameterGroup,
    });

    // Scope RDS ingress to the private (Lambda-hosting) subnet tier only, not
    // the whole VPC CIDR — the whole-VPC range also spans the public subnet
    // tier, which should never reach Postgres directly.
    const dbSecurityGroup = this.dbInstance.connections.securityGroups[0];
    if (
      vpcStack.privateSubnetsCidrStrings &&
      vpcStack.privateSubnetsCidrStrings.length > 0
    ) {
      vpcStack.privateSubnetsCidrStrings.forEach((cidr) => {
        dbSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(5432),
          `Allow PostgreSQL traffic from private subnet CIDR range ${cidr}`
        );
      });
    } else {
      throw new Error(
        "vpcStack.privateSubnetsCidrStrings is empty; refusing to fall back to " +
        "VPC-wide RDS ingress. Populate it for this VPC path before deploying."
      );
    }

    /**
     * Create IAM role for RDS Proxy
     */
    const rdsProxyRole = new iam.Role(this, `${id}-DBProxyRole`, {
      assumedBy: new iam.ServicePrincipal("rds.amazonaws.com"),
    });
    // No wildcard rds-db:connect here: the proxy authenticates to the DB with the
    // Secrets Manager credentials below (addProxy grants read on them), and the
    // instance-scoped grantConnect further down covers IAM auth. A "*" grant would
    // allow connecting as any DB user (incl. app_tc / master) on any instance.

    /**
     * Create RDS Proxy for database connections with all secrets
     */
    const secretPathAdmin = secretmanager.Secret.fromSecretNameV2(
      this,
      "AdminSecret",
      this.secretPathAdminName
    );

    const rdsProxy = this.dbInstance.addProxy(id + "-proxy", {
      secrets: [
        this.secretPathUser!,
        this.secretPathTableCreator!,
        secretPathAdmin,
      ],
      vpc: vpcStack.vpc,
      role: rdsProxyRole,
      securityGroups: this.dbInstance.connections.securityGroups,
      requireTLS: true,
    });

    rdsProxy.node.addDependency(serviceLinkedRole);

    /**
     * Workaround for TargetGroupName not being set automatically
     */
    let targetGroup = rdsProxy.node.children.find((child: any) => {
      return child instanceof rds.CfnDBProxyTargetGroup;
    }) as rds.CfnDBProxyTargetGroup;

    targetGroup.addPropertyOverride("TargetGroupName", "default");

    /**
     * Grant the role permission to connect to the database
     */
    this.dbInstance.grantConnect(rdsProxyRole);

    this.rdsProxyEndpoint = rdsProxy.endpoint;

    /**
     * Enable automatic secret rotation for database credentials
     */

    // 1. Rotation for the admin (master) credentials (single-user strategy).
    // Earlier code assumed this already existed; the deployed secret had never
    // rotated (finding F17). Attached to the instance's own generated secret
    // (the SecretTargetAttachment), so the rotation Lambda gets the host and
    // the full secret ARN. RDS Proxy rereads the secret, so new connections
    // pick up the new password; a migration running during the rotation may
    // need a re-run.
    this.dbInstance.secret!.addRotationSchedule("AdminRot", {
      automaticallyAfter: Duration.days(30),
      hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
        vpc: vpcStack.vpc,
        functionName: `${id}-AdminRotation`,
      }),
    });

    // 2. Rotation for application user credentials (multi-user strategy)
    this.secretPathUser.addRotationSchedule("AppUserRot", {
      automaticallyAfter: Duration.days(30),
      hostedRotation: secretsmanager.HostedRotation.postgreSqlMultiUser({
        vpc: vpcStack.vpc,
        masterSecret: secretPathAdmin,
        functionName: `${id}-AppUserRotation`,
      }),
    });

    // 3. Rotation for table creator credentials (multi-user strategy)
    this.secretPathTableCreator.addRotationSchedule("TableCreatorRot", {
      automaticallyAfter: Duration.days(30),
      hostedRotation: secretsmanager.HostedRotation.postgreSqlMultiUser({
        vpc: vpcStack.vpc,
        masterSecret: secretPathAdmin,
        functionName: `${id}-TableCreatorRotation`,
      }),
    });

    // Note: AWS HostedRotation automatically creates and configures:
    // - Rotation Lambda functions in the VPC
    // - Required IAM permissions for Secrets Manager and RDS
    // - Security group rules for database connectivity
    // - Multi-user strategy creates alternating users (A/B) for zero-downtime rotation
  }
}
