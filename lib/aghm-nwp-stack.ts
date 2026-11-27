
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as logs from 'aws-cdk-lib/aws-logs';
import { PriceSyncWorkflow } from './price-sync-workflow';

// Firecrawl limits (NWP-PRICE-010/011). Pages one batch scrapes at once (the function's FIRECRAWL_CONCURRENCY),
// and the plan's concurrent browsers (Free 2, Hobby 5). The workflow runs browsers / pages batches at once,
// so the plan's limit is never exceeded. Raise FIRECRAWL_PLAN_BROWSERS only after upgrading the plan.
const FIRECRAWL_PAGES_PER_BATCH = 2;
const FIRECRAWL_PLAN_BROWSERS = 2;

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
      'aghm-nwp/database', // change to aghm/database-qa when testing, aghm-nwp/database when deploying to production
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
    // needs no NAT setting of its own. The weekly workflow that invokes it (NWP-PRICE-011) is section 1b.

    // Created once by hand so the key never appears in code or templates:
    //   aws secretsmanager create-secret --name aghm-nwp/firecrawl --secret-string file://firecrawl-key.txt
    const firecrawlSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'FirecrawlApiKeySecret',
      'aghm-nwp/firecrawl',
    );

    // Database the Price updater writes to. By default the engine's database (aghm-nwp/database). For QA,
    // set cdk.json context "priceDatabaseSecretName" (or -c priceDatabaseSecretName=...) to another secret
    // holding a plain connection URL like the engine's, e.g. aghm-nwp/database-qa for the QA database. Only the Price
    // updater changes; the engine keeps its own secret. Clear it and redeploy to write to production again.
    const priceDatabaseSecretName = String(this.node.tryGetContext('priceDatabaseSecretName') ?? '').trim();
    const priceDatabaseSecret = priceDatabaseSecretName === ''
      ? databaseSecret
      : secretsmanager.Secret.fromSecretNameV2(this, 'PriceUpdaterDatabaseSecret', priceDatabaseSecretName);
    if (priceDatabaseSecretName !== '') {
      cdk.Annotations.of(this).addWarningV2('nwp:price-database-override',
        `The Price updater writes to the database in secret "${priceDatabaseSecretName}", not the engine's database. Clear priceDatabaseSecretName in cdk.json and redeploy to write to production.`);
    }

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
        DATABASE_SECRET_ARN: priceDatabaseSecret.secretArn,   // the engine's, unless priceDatabaseSecretName is set
        FIRECRAWL_SECRET_ARN: firecrawlSecret.secretArn,
        // Pages scraped at once per batch; see FIRECRAWL_PAGES_PER_BATCH at the top of this file.
        FIRECRAWL_CONCURRENCY: String(FIRECRAWL_PAGES_PER_BATCH),
        PRICE_MEDIAN_INCLUDE_STALE: 'false',
      },
      logGroup: priceUpdaterLogGroup,
      role: priceUpdaterRole,
    });
    priceDatabaseSecret.grantRead(priceUpdaterRole);   // only the secret it actually uses
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


    // 1b. BACKEND: Weekly price sync (NWP-PRICE-011)
    // EventBridge Scheduler starts a Standard state machine every Sunday at 02:00 Asia/Manila. It starts the
    // fck-nat instance if it is stopped, runs the Price updater's probe, plan, process (one per batch) and
    // finalize actions, then stops fck-nat again if it started it. See lib/price-sync-workflow.ts.
    //
    // fck-nat is a standalone EC2 instance created outside this stack. Its id comes from cdk.json
    // (context "fckNatInstanceId") or `cdk deploy -c fckNatInstanceId=i-...`. Without it the workflow and
    // schedule are left out of the template (with a warning), so engine deploys still work.
    const natInstanceId = String(this.node.tryGetContext('fckNatInstanceId') ?? '').trim();
    let priceSync: PriceSyncWorkflow | undefined;
    if (natInstanceId === '') {
      cdk.Annotations.of(this).addWarningV2('nwp:price-sync-skipped',
        'fckNatInstanceId is not set in cdk.json context: the weekly price sync workflow (NWP-PRICE-011) is not deployed.');
    } else {
      if (!/^i-[0-9a-f]{8,17}$/.test(natInstanceId)) {
        throw new Error(`fckNatInstanceId "${natInstanceId}" is not an EC2 instance id (i-...).`);
      }
      priceSync = new PriceSyncWorkflow(this, 'PriceSync', {
        priceUpdaterFn,
        natInstanceId,
        pagesPerBatch: FIRECRAWL_PAGES_PER_BATCH,
        firecrawlBrowsers: FIRECRAWL_PLAN_BROWSERS,
        scheduleExpression: 'cron(0 2 ? * SUN *)',   // Sunday 02:00 (decision by G, 2026-11-23)
        scheduleTimezone: 'Asia/Manila',
      });
    }


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
    if (priceSync) {
      new cdk.CfnOutput(this, 'PriceSyncStateMachineArn', { value: priceSync.stateMachine.stateMachineArn });
    }

    // Re-enable alongside the API Gateway above once it's active.
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
    });
  }
}
