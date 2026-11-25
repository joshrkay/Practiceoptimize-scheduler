import * as cdk from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../lib/config.js';
import { SUBNET_GROUPS } from '../network/network-stack.js';

export interface DataStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly appSecurityGroup: ec2.ISecurityGroup;
  readonly dataKeyArn: string;
  readonly secretsKeyArn: string;
  readonly backupKeyArn: string;
}

export class DataStack extends cdk.Stack {
  readonly database: rds.DatabaseInstance;
  readonly documents: s3.Bucket;
  readonly jobQueue: sqs.Queue;
  readonly backupVault: backup.BackupVault;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;
    // Imported by ARN so key grants land in IAM policies here, not in the KMS stack (avoids a stack cycle).
    const dataKey = kms.Key.fromKeyArn(this, 'DataKey', props.dataKeyArn);
    const secretsKey = kms.Key.fromKeyArn(this, 'SecretsKey', props.secretsKeyArn);
    const backupKey = kms.Key.fromKeyArn(this, 'BackupKey', props.backupKeyArn);
    const dataSubnets: ec2.SubnetSelection = { subnetGroupName: SUBNET_GROUPS.data };

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'PostgreSQL: inbound 5432 from application tasks only',
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(props.appSecurityGroup, ec2.Port.tcp(5432), 'Application tasks');

    const parameterGroup = new rds.ParameterGroup(this, 'DbParams', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      description: 'TLS 1.2+ enforced',
      parameters: {
        'rds.force_ssl': '1',
        ssl_min_protocol_version: 'TLSv1.2',
        log_connections: '1',
        log_disconnections: '1',
      },
    });

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: new ec2.InstanceType(config.dbInstanceClass),
      vpc,
      vpcSubnets: dataSubnets,
      securityGroups: [dbSg],
      publiclyAccessible: false,
      multiAz: config.dbMultiAz,
      allocatedStorage: config.dbAllocatedGb,
      maxAllocatedStorage: config.dbMaxAllocatedGb,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      storageEncryptionKey: dataKey,
      credentials: rds.Credentials.fromGeneratedSecret('scheduler_admin', {
        secretName: `scheduler/${config.name}/platform/db-admin`,
        encryptionKey: secretsKey,
      }),
      parameterGroup,
      iamAuthentication: true,
      backupRetention: cdk.Duration.days(config.backupRetentionDays),
      copyTagsToSnapshot: true,
      deleteAutomatedBackups: false,
      deletionProtection: config.deletionProtection,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
      enablePerformanceInsights: true,
      performanceInsightEncryptionKey: dataKey,
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
    });
    this.database.addRotationSingleUser({ automaticallyAfter: cdk.Duration.days(30) });

    // Encrypted, restorable backups in a vault under a dedicated key, separate from the automated snapshots.
    this.backupVault = new backup.BackupVault(this, 'BackupVault', {
      backupVaultName: `scheduler-${config.name}`,
      encryptionKey: backupKey,
      blockRecoveryPointDeletion: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const plan = new backup.BackupPlan(this, 'BackupPlan', {
      backupPlanName: `scheduler-${config.name}`,
      backupVault: this.backupVault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'daily',
          scheduleExpression: events.Schedule.cron({ minute: '0', hour: '5' }),
          deleteAfter: cdk.Duration.days(config.backupRetentionDays),
          enableContinuousBackup: true,
        }),
      ],
    });
    plan.addSelection('Database', { resources: [backup.BackupResource.fromRdsDatabaseInstance(this.database)] });

    this.documents = new s3.Bucket(this, 'Documents', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.documents.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyTlsBelow12',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:*'],
        resources: [this.documents.bucketArn, this.documents.arnForObjects('*')],
        conditions: { NumericLessThan: { 's3:TlsVersion': 1.2 } },
      }),
    );

    // Queues have no subnets: they are reachable only through the VPC endpoint, enforced by policy.
    const dlq = this.privateQueue('JobDlq', dataKey, vpc, { retentionPeriod: cdk.Duration.days(14) });
    this.jobQueue = this.privateQueue('JobQueue', dataKey, vpc, {
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });
  }

  private privateQueue(id: string, key: kms.IKey, vpc: ec2.IVpc, extra: Partial<sqs.QueueProps>): sqs.Queue {
    const queue = new sqs.Queue(this, id, {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      enforceSSL: true,
      ...extra,
    });
    queue.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyOutsideVpc',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sqs:*'],
        resources: [queue.queueArn],
        conditions: { StringNotEquals: { 'aws:SourceVpc': vpc.vpcId } },
      }),
    );
    queue.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyTlsBelow12',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sqs:*'],
        resources: [queue.queueArn],
        conditions: { NumericLessThan: { 'aws:TlsVersion': 1.2 } },
      }),
    );
    return queue;
  }
}
