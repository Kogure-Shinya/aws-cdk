import * as path from 'path';
import * as cloudwatch from '@aws-cdk/aws-cloudwatch';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import * as ssm from '@aws-cdk/aws-ssm';
import {
  BootstraplessSynthesizer, Construct as CoreConstruct, ConstructNode,
  CustomResource, CustomResourceProvider, CustomResourceProviderRuntime,
  DefaultStackSynthesizer, IStackSynthesizer, Resource, Stack, StackProps, Stage, Token,
} from '@aws-cdk/core';
import { Construct } from 'constructs';
import { Alias, AliasOptions } from './alias';
import { EventInvokeConfigOptions } from './event-invoke-config';
import { IEventSource } from './event-source';
import { EventSourceMapping, EventSourceMappingOptions } from './event-source-mapping';
import { Function, FunctionProps } from './function';
import { IFunction } from './function-base';
import { extractQualifierFromArn, IVersion } from './lambda-version';
import { Permission } from './permission';

/**
 * Properties for creating a Lambda@Edge function
 * @experimental
 */
export interface EdgeFunctionProps extends FunctionProps { }

/**
 * A Lambda@Edge function.
 *
 * Convenience resource for requesting a Lambda function in the 'us-east-1' region for use with Lambda@Edge.
 * Implements several restrictions enforced by Lambda@Edge.
 *
 * @resource AWS::Lambda::Function
 * @experimental
 */
export class EdgeFunction extends Resource implements IVersion {

  private static readonly EDGE_REGION: string = 'us-east-1';

  public readonly edgeArn: string;
  public readonly functionName: string;
  public readonly functionArn: string;
  public readonly grantPrincipal: iam.IPrincipal;
  public readonly isBoundToVpc = false;
  public readonly lambda: IFunction;
  public readonly permissionsNode: ConstructNode;
  public readonly role?: iam.IRole;
  public readonly version: string;

  // functionStack and currentVersion needed for `addAlias`.
  private readonly functionStack: Stack;
  private readonly currentVersion: IVersion;

  constructor(scope: Construct, id: string, props: EdgeFunctionProps) {
    super(scope, id);

    // Create a simple Function if we're already in us-east-1; otherwise create a cross-region stack.
    const regionIsUsEast1 = !Token.isUnresolved(this.stack.region) && this.stack.region === 'us-east-1';
    const { functionStack, edgeFunction, currentVersion, edgeArn } = regionIsUsEast1
      ? this.createInRegionFunction(id, props)
      : this.createCrossRegionFunction(id, props);

    this.functionStack = functionStack;
    this.edgeArn = edgeArn;
    this.functionArn = edgeArn;
    this.currentVersion = currentVersion;
    this.lambda = edgeFunction;
    this.functionName = this.lambda.functionName;
    this.grantPrincipal = this.lambda.role!;
    this.permissionsNode = this.lambda.permissionsNode;
    this.version = extractQualifierFromArn(this.functionArn);
  }

  public addAlias(aliasName: string, options: AliasOptions = {}): Alias {
    return new Alias(this.functionStack, `Alias${aliasName}`, {
      aliasName,
      version: this.currentVersion,
      ...options,
    });
  }

  /**
   * Not supported. Connections are only applicable to VPC-enabled functions.
   */
  public get connections(): ec2.Connections {
    throw new Error('Lambda@Edge does not support connections');
  }
  public get latestVersion(): IVersion {
    throw new Error('$LATEST function version cannot be used for Lambda@Edge');
  }

  public addEventSourceMapping(id: string, options: EventSourceMappingOptions): EventSourceMapping {
    return this.lambda.addEventSourceMapping(id, options);
  }
  public addPermission(id: string, permission: Permission): void {
    return this.lambda.addPermission(id, permission);
  }
  public addToRolePolicy(statement: iam.PolicyStatement): void {
    return this.lambda.addToRolePolicy(statement);
  }
  public grantInvoke(identity: iam.IGrantable): iam.Grant {
    return this.lambda.grantInvoke(identity);
  }
  public metric(metricName: string, props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.lambda.metric(metricName, { ...props, region: EdgeFunction.EDGE_REGION });
  }
  public metricDuration(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.lambda.metricDuration({ ...props, region: EdgeFunction.EDGE_REGION });
  }
  public metricErrors(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.lambda.metricErrors({ ...props, region: EdgeFunction.EDGE_REGION });
  }
  public metricInvocations(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.lambda.metricInvocations({ ...props, region: EdgeFunction.EDGE_REGION });
  }
  public metricThrottles(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.lambda.metricThrottles({ ...props, region: EdgeFunction.EDGE_REGION });
  }
  public addEventSource(source: IEventSource): void {
    return this.lambda.addEventSource(source);
  }
  public configureAsyncInvoke(options: EventInvokeConfigOptions): void {
    return this.lambda.configureAsyncInvoke(options);
  }

  /** Create a function in-region */
  private createInRegionFunction(id: string, props: FunctionProps): FunctionConfig {
    const role = props.role ?? defaultLambdaRole(this, id);
    const edgeFunction = new Function(this, 'Fn', {
      ...props,
      role,
    });
    const currentVersion = edgeFunction.currentVersion;

    return { edgeFunction, currentVersion, edgeArn: currentVersion.edgeArn, functionStack: this.stack };
  }

  /** Create a support stack and function in us-east-1, and a SSM reader in-region */
  private createCrossRegionFunction(id: string, props: FunctionProps): FunctionConfig {
    const parameterName = `EdgeFunctionArn${id}`;
    const functionStack = this.edgeStack();
    this.stack.addDependency(functionStack);

    const { edgeFunction, currentVersion } = functionStack.addEdgeFunction(id, parameterName, props);

    const parameterArn = this.stack.formatArn({
      service: 'ssm',
      region: EdgeFunction.EDGE_REGION,
      resource: 'parameter',
      resourceName: parameterName,
    });

    const resourceType = 'Custom::CrossRegionStringParameterReader';
    const serviceToken = CustomResourceProvider.getOrCreate(this, resourceType, {
      codeDirectory: path.join(__dirname, 'edge-function'),
      runtime: CustomResourceProviderRuntime.NODEJS_12,
      policyStatements: [{
        Effect: 'Allow',
        Resource: parameterArn,
        Action: ['ssm:GetParameter'],
      }],
    });
    const resource = new CustomResource(this, 'ArnReader', {
      resourceType: resourceType,
      serviceToken,
      properties: {
        Region: EdgeFunction.EDGE_REGION,
        ParameterName: parameterName,
        RefreshEachDeploy: Date.now().toString(), // Ensure this value is refreshed on each deploy, to get the latest function ARN.
      },
    });
    const edgeArn = resource.getAttString('FunctionArn');

    return { edgeFunction, currentVersion, edgeArn, functionStack };
  }

  private edgeStack(): CrossRegionLambdaStack {
    const stage = this.node.root;
    if (!stage || !Stage.isStage(stage)) {
      throw new Error('stacks which use EdgeFunctions must be part of a CDK app or stage');
    }
    const region = this.env.region;
    if (Token.isUnresolved(region)) {
      throw new Error('stacks which use EdgeFunctions must have an explicitly set region');
    }

    const edgeStackId = `edge-lambda-stack-${region}`;
    let edgeStack = stage.node.tryFindChild(edgeStackId) as CrossRegionLambdaStack;
    if (!edgeStack) {
      edgeStack = new CrossRegionLambdaStack(stage, edgeStackId, {
        synthesizer: this.getCrossRegionSupportSynthesizer(),
        env: { region: EdgeFunction.EDGE_REGION },
      });
    }
    return edgeStack;
  }

  // Stolen from `@aws-cdk/aws-codepipeline`'s `Pipeline`.
  private getCrossRegionSupportSynthesizer(): IStackSynthesizer | undefined {
    // If we have the new synthesizer we need a bootstrapless copy of it,
    // because we don't want to require bootstrapping the environment
    // of the account in this replication region.
    // Otheriwse, return undefined to use the default.
    return (this.stack.synthesizer instanceof DefaultStackSynthesizer)
      ? new BootstraplessSynthesizer({
        deployRoleArn: this.stack.synthesizer.deployRoleArn,
        cloudFormationExecutionRoleArn: this.stack.synthesizer.cloudFormationExecutionRoleArn,
      })
      : undefined;
  }
}

/** Result of creating an in-region or cross-region function */
interface FunctionConfig {
  readonly edgeFunction: IFunction;
  readonly currentVersion: IVersion;
  readonly edgeArn: string;
  readonly functionStack: Stack;
}

class CrossRegionLambdaStack extends Stack {

  constructor(scope: CoreConstruct, id: string, props: StackProps) {
    super(scope, id, props);
  }

  public addEdgeFunction(id: string, parameterName: string, props: FunctionProps) {
    const role = props.role ?? defaultLambdaRole(this, id);

    const edgeFunction = new Function(this, id, {
      ...props,
      role,
    });
    const currentVersion = edgeFunction.currentVersion;

    new ssm.StringParameter(edgeFunction, 'Parameter', {
      parameterName,
      stringValue: currentVersion.edgeArn,
    });

    return { edgeFunction, currentVersion };
  }
}

function defaultLambdaRole(scope: Construct, id: string): iam.IRole {
  return new iam.Role(scope, `${id}ServiceRole`, {
    assumedBy: new iam.CompositePrincipal(
      new iam.ServicePrincipal('lambda.amazonaws.com'),
      new iam.ServicePrincipal('edgelambda.amazonaws.com'),
    ),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
  });
}

