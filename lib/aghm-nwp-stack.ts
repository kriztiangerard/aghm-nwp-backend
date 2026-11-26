
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as logs from 'aws-cdk-lib/aws-logs';

export class AghmNwpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const amplifyRole = new iam.Role(this, 'AmplifyServiceRole', {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      description: 'Service role used by AWS Amplify to run builds',
    });

    amplifyRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess-Amplify')
    );


    // 1. BACKEND: AWS Lambda Functions
    const vpc = ec2.Vpc.fromLookup(this, 'EngineVpc', {
      vpcId: 'vpc-06f55cc32200b2717',
    });

    const lambdaSubnets = [
      ec2.Subnet.fromSubnetAttributes(this, 'LambdaSubnetA', {
        subnetId: 'subnet-0a5873e4b08810625', availabilityZone: 'ap-southeast-1a', routeTableId: 'rtb-0034daa508cc8947b',
      }),
      ec2.Subnet.fromSubnetAttributes(this, 'LambdaSubnetB', {
        subnetId: 'subnet-0314e01bfb11c0bc7', availabilityZone: 'ap-southeast-1b', routeTableId: 'rtb-0034daa508cc8947b',
      }),
    ];

    const lambdaSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this, 'BackendSg', 'sg-08314c5a76cbd8cb0',
    );

    const databaseSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'EngineDatabaseSecret',
      'aghm-nwp/database',
    );

    const makeLogGroup = (id: string) =>
    new logs.LogGroup(this, id, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Update for Step Functions
    
      const repositoryRoot = path.join(__dirname, '..');
      const handlersDir = path.join(repositoryRoot, 'src', 'types', 'engine', 'handlers');
      const databaseEnvironment = {
        DATABASE_SECRET_ARN: databaseSecret.secretArn,
        DB_SSL: 'true',
      };

      const baseProps: lambdaNodejs.NodejsFunctionProps = {
        projectRoot: repositoryRoot,
        depsLockFilePath: path.join(repositoryRoot, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_22_X,   // Node 20 is past end-of-life; confirm 22 is still supported
        handler: 'handler',                    // the export name only; NodejsFunction adds the file name itself
      };
      // The Lambdas that read RDS: inside the VPC, same security group, so one ingress rule covers them all.
      const vpcProps: lambdaNodejs.NodejsFunctionProps = {
        ...baseProps,
        vpc,
        // Listed explicitly, not selected by type: these subnets' route table now sends 0.0.0.0/0 to the
        // fck-nat instance, so a refreshed VPC lookup (cdk context --reset) could stop classifying them as
        // Isolated and leave a type-based selection empty. Same two subnets the cached lookup lists as Isolated.
        vpcSubnets: { subnets: lambdaSubnets },
        securityGroups: [lambdaSecurityGroup],
        bundling: { loader: { '.pem': 'text' } },
      };

      // Map stage: one invocation per vendor.
      const vendorPlansFn = new lambdaNodejs.NodejsFunction(this, 'VendorPlansFunction', {
        ...vpcProps,
        entry: path.join(handlersDir, 'vendor-plans.js'),
        timeout: cdk.Duration.seconds(20),
        memorySize: 1024,
        environment: databaseEnvironment,
        logGroup: makeLogGroup('VendorPlansLogs'),
      });
      databaseSecret.grantRead(vendorPlansFn);

      // Final stage: no database, so no VPC and no secret.
      const assembleFn = new lambdaNodejs.NodejsFunction(this, 'AssembleFunction', {
        ...baseProps,
        entry: path.join(handlersDir, 'assemble.js'),
        timeout: cdk.Duration.seconds(15),
        memorySize: 512,
        logGroup: makeLogGroup('AssembleLogs'),
      });

      

      const retryOnTransient = {
        errors: [
          'Lambda.ClientExecutionTimeoutException',
          'Lambda.ServiceException',
          'Lambda.AWSLambdaException',
          'Lambda.SdkClientException',
        ],
        interval: cdk.Duration.seconds(2),
        maxAttempts: 2,
        backoffRate: 2,
      };

      const buildVendorPlans = new tasks.LambdaInvoke(this, 'BuildVendorPlans', {
        lambdaFunction: vendorPlansFn,
        payloadResponseOnly: true,
        retryOnServiceExceptions: false,
      }).addRetry(retryOnTransient);

      const perVendor = new sfn.Map(this, 'PerVendor', {
        itemsPath: '$.vendors',   // newer CDK prefers items: sfn.ProvideItems.jsonPath('$.vendors'); both work
        maxConcurrency: 3,
        itemSelector: {
          vendor: sfn.JsonPath.objectAt('$$.Map.Item.Value'),
          input: sfn.JsonPath.objectAt('$.input'),
          requirements: sfn.JsonPath.objectAt('$.requirements'),
          sharedLedger: sfn.JsonPath.objectAt('$.ctx.ledger'),
          now: sfn.JsonPath.stringAt('$.now'),
        },
        resultPath: '$.vendorResults',
      }).itemProcessor(buildVendorPlans);

      const assemble = new tasks.LambdaInvoke(this, 'Assemble', {
        lambdaFunction: assembleFn,
        payloadResponseOnly: true,
        retryOnServiceExceptions: false,
      }).addRetry(retryOnTransient);

      const workflowLogs = new logs.LogGroup(this, 'EngineWorkflowLogs', {
        logGroupName: '/aws/vendedlogs/states/aghm-nwp-engine',
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const engineMachine = new sfn.StateMachine(this, 'EngineStateMachine', {
        stateMachineType: sfn.StateMachineType.EXPRESS,   // Express only: Standard would keep user inputs for 90 days
        definitionBody: sfn.DefinitionBody.fromChainable(perVendor.next(assemble)),
        timeout: cdk.Duration.seconds(25),
        logs: {
          destination: workflowLogs,
          level: sfn.LogLevel.ERROR,
          includeExecutionData: false,   // keeps user inputs out of the logs
        },
      });

      // API-facing Lambda: validates, then runs the workflow and waits for it.
      const entryFn = new lambdaNodejs.NodejsFunction(this, 'EntryFunction', {
        ...vpcProps,
        entry: path.join(handlersDir, 'entry.js'),
        timeout: cdk.Duration.seconds(29),   // API Gateway HTTP APIs cut off at 30 s
        memorySize: 512,
        environment: { ...databaseEnvironment, STATE_MACHINE_ARN: engineMachine.stateMachineArn },
        logGroup: makeLogGroup('EntryLogs'),
      });
      databaseSecret.grantRead(entryFn);
      engineMachine.grantStartSyncExecution(entryFn);


    // 1c. BACKEND: Price updater (NWP-PRICE-010)
    // Same subnets and security group as the engine Lambdas (vpcProps). Those subnets' route table sends
    // 0.0.0.0/0 to the fck-nat instance, so the function reaches Firecrawl whenever fck-nat is running; it
    // needs no NAT setting of its own. The weekly workflow that invokes it is NWP-PRICE-011.

    // Created once by hand so the key never appears in code or templates:
    //   aws secretsmanager create-secret --name aghm-nwp/firecrawl --secret-string file://firecrawl-key.txt
    const firecrawlSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'FirecrawlApiKeySecret',
      'aghm-nwp/firecrawl',
    );

    // Explicit role (AC4: read the two secrets and write its own logs). Without one, CDK attaches
    // AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole, which allow writing to every log
    // group in the account. Logs: only this function's log group (it already exists, so no CreateLogGroup).
    // Network interfaces: required for any Lambda in a VPC and only grantable on "*" (AWS does not support
    // narrowing them); they let Lambda attach the function to its subnets, nothing more.
    const priceUpdaterLogGroup = makeLogGroup('PriceUpdaterLogs');
    const priceUpdaterRole = new iam.Role(this, 'PriceUpdaterRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Price updater (NWP-PRICE-010): own logs, VPC network interfaces, Firecrawl and database secrets',
    });
    priceUpdaterRole.addToPolicy(new iam.PolicyStatement({
      sid: 'OwnLogGroupOnly',
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [priceUpdaterLogGroup.logGroupArn],   // arn:...:log-group:<name>:* (its streams)
    }));
    priceUpdaterRole.addToPolicy(new iam.PolicyStatement({
      sid: 'VpcNetworkInterfaces',
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeSubnets',
        'ec2:DeleteNetworkInterface',
        'ec2:AssignPrivateIpAddresses',
        'ec2:UnassignPrivateIpAddresses',
      ],
      resources: ['*'],
    }));

    const priceUpdaterFn = new lambdaNodejs.NodejsFunction(this, 'PriceUpdaterFunction', {
      ...vpcProps,
      entry: path.join(repositoryRoot, 'src', 'pricing', 'handler.js'),
      timeout: cdk.Duration.minutes(15),   // one vendor x distributor batch per call; Lambda's maximum. Revisit after a real run.
      memorySize: 512,                     // waits on Firecrawl over the network; little CPU or memory needed
      environment: {
        ...databaseEnvironment,
        FIRECRAWL_SECRET_ARN: firecrawlSecret.secretArn,
        // Pages scraped at once. Must not exceed the Firecrawl plan's concurrent browsers (Free 2, Hobby 5);
        // extra requests only queue. 2 fits the Free plan; raise it only after upgrading.
        FIRECRAWL_CONCURRENCY: '2',
        PRICE_MEDIAN_INCLUDE_STALE: 'false',
      },
      logGroup: priceUpdaterLogGroup,
      role: priceUpdaterRole,
    });
    databaseSecret.grantRead(priceUpdaterRole);
    firecrawlSecret.grantRead(priceUpdaterRole);


    // 1a. BACKEND: API Gateway routes requests to the active engine handler.

    const httpApi = new apigwv2.HttpApi(this, 'NwpHttpApi', {
      apiName: 'NWP Engine API',
      corsPreflight: {
       allowOrigins: ['*'], // TODO: tighten to the Amplify domain once known
       allowMethods: [apigwv2.CorsHttpMethod.POST],
       allowHeaders: ['Content-Type'],
      },
    });

    const engineIntegration = new HttpLambdaIntegration(
      'EngineIntegration',
      entryFn,
    );

    httpApi.addRoutes({
      path: '/generate',
      methods: [apigwv2.HttpMethod.POST],
      integration: engineIntegration,
    });


    // 1b. BACKEND: EventBridge schedule (triggers the price sync)

    // Placeholder only. NWP-PRICE-011 replaces it with a weekly EventBridge Scheduler schedule (the manuscript
    // says weekly) that starts the sync workflow, which in turn invokes priceUpdaterFn (section 1c).

    // const pricingUpdateRule = new events.Rule(this, 'PricingUpdateSchedule', {
    //   schedule: events.Schedule.cron({ minute: '0', hour: '2' }),
    // });

    // pricingUpdateRule.addTarget(new targets.LambdaFunction(pricingUpdateLambda));


    // 2. FRONTEND: Moved to its own repository; use console
    // Token kept as reference in case needed.

    // .unsafeUnwrap() safely converts the CDK SecretValue object
    // into a plain string that CloudFormation can resolve during deployment.
    /* const githubToken = cdk
      .SecretValue
      .secretsManager('github-oauth-token')
      .unsafeUnwrap();
    */

    // 3. OUTPUTS

    new cdk.CfnOutput(this, 'EntryFunctionName', { value: entryFn.functionName });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: engineMachine.stateMachineArn });

    new cdk.CfnOutput(this, 'PriceUpdaterFunctionName', { value: priceUpdaterFn.functionName });

    // Re-enable alongside the API Gateway above once it's active.
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
    });
  }
}
