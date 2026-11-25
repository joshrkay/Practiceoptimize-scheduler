import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as nfw from 'aws-cdk-lib/aws-networkfirewall';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../lib/config.js';

export const TIER_TAG = 'scheduler:subnet-tier';
export const SUBNET_GROUPS = {
  /** Holds NAT gateways only. Nothing else may be placed here. */
  nat: 'nat',
  app: 'app',
  data: 'data',
  firewall: 'firewall',
} as const;

export interface NetworkStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly logsKey: kms.IKey;
}

export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly appSecurityGroup: ec2.SecurityGroup;
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config, logsKey } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.cidr),
      maxAzs: config.maxAzs,
      natGateways: config.natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: SUBNET_GROUPS.nat, subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28, mapPublicIpOnLaunch: false },
        { name: SUBNET_GROUPS.firewall, subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
        { name: SUBNET_GROUPS.app, subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: SUBNET_GROUPS.data, subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    for (const [group, tier] of Object.entries(SUBNET_GROUPS)) {
      for (const s of this.vpc.selectSubnets({ subnetGroupName: group }).subnets) {
        cdk.Tags.of(s).add(TIER_TAG, tier);
      }
    }

    this.appSecurityGroup = new ec2.SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      description: 'Application and worker tasks. No inbound; outbound HTTPS and Postgres only.',
      allowAllOutbound: false,
    });
    this.appSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS (filtered by Network Firewall allowlist)');
    this.appSecurityGroup.addEgressRule(ec2.Peer.ipv4(config.cidr), ec2.Port.tcp(5432), 'PostgreSQL inside the VPC');

    this.addEgressInspection(config, logsKey);
    this.addEndpoints(config);
    this.addFlowLogs(logsKey);
    this.webAcl = this.addWaf(config, logsKey);
  }

  private addEgressInspection(config: EnvironmentConfig, logsKey: kms.IKey): void {
    const ruleGroup = new nfw.CfnRuleGroup(this, 'EgressAllowlist', {
      ruleGroupName: `scheduler-${config.name}-egress-allowlist`,
      type: 'STATEFUL',
      capacity: 100,
      ruleGroup: {
        ruleVariables: { ipSets: { HOME_NET: { definition: [config.cidr] } } },
        rulesSource: {
          rulesSourceList: {
            generatedRulesType: 'ALLOWLIST',
            targetTypes: ['TLS_SNI', 'HTTP_HOST'],
            targets: [...config.egressAllowlist],
          },
        },
        statefulRuleOptions: { ruleOrder: 'STRICT_ORDER' },
      },
    });

    const policy = new nfw.CfnFirewallPolicy(this, 'EgressPolicy', {
      firewallPolicyName: `scheduler-${config.name}-egress`,
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulEngineOptions: { ruleOrder: 'STRICT_ORDER' },
        statefulDefaultActions: ['aws:drop_established', 'aws:alert_established'],
        statefulRuleGroupReferences: [{ resourceArn: ruleGroup.attrRuleGroupArn, priority: 1 }],
      },
    });

    const fwSubnets = this.vpc.selectSubnets({ subnetGroupName: SUBNET_GROUPS.firewall }).subnets;
    const firewall = new nfw.CfnFirewall(this, 'Firewall', {
      firewallName: `scheduler-${config.name}-egress`,
      firewallPolicyArn: policy.attrFirewallPolicyArn,
      vpcId: this.vpc.vpcId,
      deleteProtection: config.deletionProtection,
      subnetMappings: fwSubnets.map((s) => ({ subnetId: s.subnetId })),
    });

    const logGroup = new logs.LogGroup(this, 'FirewallLogs', {
      encryptionKey: logsKey,
      retention: logs.RetentionDays.ONE_YEAR,
    });
    new nfw.CfnLoggingConfiguration(this, 'FirewallLogging', {
      firewallArn: firewall.attrFirewallArn,
      loggingConfiguration: {
        logDestinationConfigs: [
          { logType: 'ALERT', logDestinationType: 'CloudWatchLogs', logDestination: { logGroup: logGroup.logGroupName } },
        ],
      },
    });

    // Route all internet traffic through the per-AZ firewall endpoint:
    // app -> NAT (default CDK route) -> firewall -> IGW, and the reverse via an edge route table on the IGW.
    // NOTE: endpoint order in attrEndpointIds is assumed to follow subnetMappings order; verify on first deploy.
    const endpointFor = (index: number): string =>
      cdk.Fn.select(1, cdk.Fn.split(':', cdk.Fn.select(index, firewall.attrEndpointIds)));

    const natSubnets = this.vpc.selectSubnets({ subnetGroupName: SUBNET_GROUPS.nat }).subnets as ec2.Subnet[];
    const edge = new ec2.CfnRouteTable(this, 'IgwEdgeRoutes', { vpcId: this.vpc.vpcId });
    new ec2.CfnGatewayRouteTableAssociation(this, 'IgwEdgeAssociation', {
      gatewayId: this.vpc.internetGatewayId as string,
      routeTableId: edge.ref,
    });
    natSubnets.forEach((subnet, i) => {
      // Repoint the default route (which the NAT gateway depends on) from the IGW to the firewall endpoint.
      const defaultRoute = subnet.node.findChild('DefaultRoute') as ec2.CfnRoute;
      defaultRoute.addPropertyDeletionOverride('GatewayId');
      defaultRoute.addPropertyOverride('VpcEndpointId', endpointFor(i));
      new ec2.CfnRoute(this, `IgwReturn${i}`, {
        routeTableId: edge.ref,
        destinationCidrBlock: subnet.ipv4CidrBlock,
        vpcEndpointId: endpointFor(i),
      });
    });
    (fwSubnets as ec2.Subnet[]).forEach((subnet, i) => {
      const route = new ec2.CfnRoute(this, `FirewallToIgw${i}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: '0.0.0.0/0',
        gatewayId: this.vpc.internetGatewayId as string,
      });
      route.node.addDependency(this.vpc.internetConnectivityEstablished);
    });
  }

  private addEndpoints(config: EnvironmentConfig): void {
    const sg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      description: 'Interface VPC endpoints: HTTPS from inside the VPC only',
      allowAllOutbound: false,
    });
    sg.addIngressRule(ec2.Peer.ipv4(config.cidr), ec2.Port.tcp(443), 'HTTPS from VPC');

    const subnets = { subnetGroupName: SUBNET_GROUPS.app };
    const interfaceServices: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      BedrockRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      Kms: ec2.InterfaceVpcEndpointAwsService.KMS,
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      Sqs: ec2.InterfaceVpcEndpointAwsService.SQS,
      Sts: ec2.InterfaceVpcEndpointAwsService.STS,
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    };
    for (const [name, service] of Object.entries(interfaceServices)) {
      const ep = new ec2.InterfaceVpcEndpoint(this, `${name}Endpoint`, {
        vpc: this.vpc,
        service,
        subnets,
        securityGroups: [sg],
        privateDnsEnabled: true,
      });
      if (name === 'BedrockRuntime') {
        // Model calls stay on the AWS network and are limited to inference actions.
        ep.addToPolicy(
          new iam.PolicyStatement({
            principals: [new iam.AnyPrincipal()],
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
            resources: ['*'],
          }),
        );
      }
    }
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetGroupName: SUBNET_GROUPS.app }, { subnetGroupName: SUBNET_GROUPS.data }],
    });
  }

  private addFlowLogs(logsKey: kms.IKey): void {
    const logGroup = new logs.LogGroup(this, 'FlowLogs', {
      encryptionKey: logsKey,
      retention: logs.RetentionDays.ONE_YEAR,
    });
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
  }

  private addWaf(config: EnvironmentConfig, logsKey: kms.IKey): wafv2.CfnWebACL {
    const managed = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: name },
    });
    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `scheduler-${config.name}-web`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: `scheduler-${config.name}-web` },
      rules: [
        managed('AWSManagedRulesCommonRuleSet', 10),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 20),
        managed('AWSManagedRulesSQLiRuleSet', 30),
        {
          name: 'RateLimitPerIp',
          priority: 40,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'RateLimitPerIp' },
        },
      ],
    });
    // WAF requires the log group name to start with aws-waf-logs-.
    const logGroup = new logs.LogGroup(this, 'WafLogs', {
      logGroupName: `aws-waf-logs-scheduler-${config.name}`,
      encryptionKey: logsKey,
      retention: logs.RetentionDays.ONE_YEAR,
    });
    new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
      resourceArn: acl.attrArn,
      logDestinationConfigs: [logGroup.logGroupArn],
      redactedFields: [{ singleHeader: { Name: 'authorization' } }, { singleHeader: { Name: 'cookie' } }, { queryString: {} }],
    });
    return acl;
  }
}
