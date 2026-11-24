import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

// NWP-PRICE-011: the weekly price synchronization workflow.
//
//   Init → DescribeNat ─┬ running ──────────────────────────────┐
//                       ├ stopped → StartNat → (wait + describe) ┤
//                       └ pending / stopping → (wait + describe) ┤
//                                                                ▼
//   Probe (retried while fck-nat comes up) → Plan → Map(ProcessBatch, Catch → MarkBatchFailed)
//     → Finalize → stop fck-nat if this execution started it → Succeed, or Fail when no price was collected
//
// The Map stops early when a batch reports an account-level error (auth_error, quota_exceeded,
// network_error): that iteration ends in the PriceSync.AccountLevelStop Fail state, which stops the Map;
// the Map's Catch for that error goes on to Finalize. Every other failure goes to the cleanup path, which
// also stops fck-nat if this execution started it, then fails the execution.
//
// Standard, not Express: Express executions are limited to 5 minutes and a run takes longer.

export interface PriceSyncWorkflowProps {
  /** The Price updater Lambda (NWP-PRICE-010); every step invokes it with { action, ... }. */
  readonly priceUpdaterFn: lambda.IFunction;
  /** The fck-nat EC2 instance (standalone instance, decision by G 2026-11-23). */
  readonly natInstanceId: string;
  /** Pages one batch scrapes at once: the function's FIRECRAWL_CONCURRENCY. */
  readonly pagesPerBatch: number;
  /** Concurrent browsers on the Firecrawl plan (Free 2, Hobby 5). Batches run at once = browsers / pages per batch. */
  readonly firecrawlBrowsers: number;
  /** EventBridge Scheduler expression. Default: Sundays at 02:00. */
  readonly scheduleExpression?: string;
  /** Default: Asia/Manila. */
  readonly scheduleTimezone?: string;
}

const NAT_POLL_SECONDS = 15;
const NAT_MAX_POLLS = 40;   // 10 minutes for the instance to stop (if stopping) and start

export class PriceSyncWorkflow extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly batchConcurrency: number;

  constructor(scope: Construct, id: string, props: PriceSyncWorkflowProps) {
    super(scope, id);

    const fn = props.priceUpdaterFn;
    this.batchConcurrency = Math.max(1, Math.floor(props.firecrawlBrowsers / props.pagesPerBatch));
    const natArn = cdk.Stack.of(this).formatArn({
      service: 'ec2', resource: 'instance', resourceName: props.natInstanceId,
    });

    const retryOnTransient: sfn.RetryProps = {
      errors: [
        'Lambda.ClientExecutionTimeoutException',
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
      ],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 2,
      backoffRate: 2,
    };
    const invoke = (stateId: string, payload: Record<string, unknown>, more: Partial<tasks.LambdaInvokeProps> = {}) =>
      new tasks.LambdaInvoke(this, stateId, {
        lambdaFunction: fn,
        payload: sfn.TaskInput.fromObject(payload),
        payloadResponseOnly: true,
        retryOnServiceExceptions: false,
        ...more,
      }).addRetry(retryOnTransient);

    // ---- Cleanup path: any failure ends here; fck-nat is stopped if this execution started it. ----
    const runFailed = new sfn.Fail(this, 'RunFailed', {
      errorPath: '$.failure.Error',
      causePath: '$.failure.Cause',
    });
    const natNotStopped = new sfn.Fail(this, 'NatNotStopped', {
      error: 'PriceSync.NatNotStopped',
      cause: `The run failed and fck-nat (${props.natInstanceId}) could not be stopped. Stop it by hand.`,
    });
    const stopNatAfterFailure = this.stopNat('StopNatAfterFailure', props.natInstanceId, natArn)
      .addCatch(natNotStopped, { resultPath: '$.stopError' });
    stopNatAfterFailure.next(runFailed);
    const cleanup = new sfn.Choice(this, 'StartedNatBeforeFailure?')
      .when(sfn.Condition.booleanEquals('$.run.startedNat', true), stopNatAfterFailure)
      .otherwise(runFailed);
    const catchAll = { resultPath: '$.failure' };

    // ---- 1. fck-nat: start it if stopped, wait until running. ----
    const init = new sfn.Pass(this, 'Init', {
      result: sfn.Result.fromObject({ startedNat: false, natPolls: { count: 0 }, stop: null }),
      resultPath: '$.run',
    });
    const describeNat = new tasks.CallAwsService(this, 'DescribeNat', {
      service: 'ec2',
      action: 'describeInstances',
      parameters: { InstanceIds: [props.natInstanceId] },
      iamResources: ['*'],   // DescribeInstances has no resource-level permissions
      resultSelector: { 'state.$': '$.Reservations[0].Instances[0].State.Name' },
      resultPath: '$.nat',
    }).addCatch(cleanup, catchAll);
    const startNat = new tasks.CallAwsService(this, 'StartNat', {
      service: 'ec2',
      action: 'startInstances',
      parameters: { InstanceIds: [props.natInstanceId] },
      iamResources: [natArn],
      resultPath: sfn.JsonPath.DISCARD,
    }).addCatch(cleanup, catchAll);
    const markStarted = new sfn.Pass(this, 'MarkNatStartedByRun', {
      result: sfn.Result.fromBoolean(true),
      resultPath: '$.run.startedNat',
    });
    const countPoll = new sfn.Pass(this, 'CountNatPoll', {
      parameters: { 'count.$': 'States.MathAdd($.run.natPolls.count, 1)' },
      resultPath: '$.run.natPolls',
    });
    const natTimedOut = new sfn.Pass(this, 'NatDidNotStart', {
      parameters: {
        Error: 'PriceSync.NatNotRunning',
        'Cause.$': `States.Format('fck-nat (${props.natInstanceId}) was still {} after ${(NAT_POLL_SECONDS * NAT_MAX_POLLS) / 60} minutes.', $.nat.state)`,
      },
      resultPath: '$.failure',
    }).next(cleanup);
    const waitForNat = new sfn.Wait(this, 'WaitForNat', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(NAT_POLL_SECONDS)),
    });
    const tooManyPolls = new sfn.Choice(this, 'NatPollsLeft?')
      .when(sfn.Condition.numberGreaterThanEquals('$.run.natPolls.count', NAT_MAX_POLLS), natTimedOut)
      .otherwise(waitForNat);

    // ---- 2. Probe, plan, batches, finalize. ----
    const probe = invoke('Probe', { action: 'probe' }, { resultPath: sfn.JsonPath.DISCARD })
      // ProbeFailedError: no outbound access yet (fck-nat still booting). About 6 minutes in all.
      .addRetry({ errors: ['ProbeFailedError'], interval: cdk.Duration.seconds(10), maxAttempts: 8, backoffRate: 1.5, maxDelay: cdk.Duration.seconds(90) })
      .addCatch(cleanup, catchAll);

    const plan = invoke('Plan', { action: 'plan', 'runAt.$': '$$.Execution.StartTime' }, {
      resultSelector: { 'runAt.$': '$.runAt', 'batchCount.$': '$.batchCount', 'sourceCount.$': '$.sourceCount', 'batches.$': '$.batches' },
      resultPath: '$.plan',
    }).addCatch(cleanup, catchAll);

    // One Map item = one vendor x distributor batch. A batch that fails as a whole (timeout, crash) is
    // recorded by markBatchFailed and the Map goes on.
    const batchDone = new sfn.Succeed(this, 'BatchDone');
    const markBatchFailed = invoke('MarkBatchFailed', {
      action: 'markBatchFailed', 'batch.$': '$.batch', 'error.$': '$.error',
    }, { resultPath: '$.failed' })
      .addCatch(new sfn.Pass(this, 'BatchFailureNotRecorded').next(batchDone), { resultPath: '$.markError' });
    markBatchFailed.next(batchDone);

    const accountLevelStop = new sfn.Fail(this, 'AccountLevelStop', {
      error: 'PriceSync.AccountLevelStop',
      causePath: sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt('$.result.stoppedBy')),
    });
    const processBatch = invoke('ProcessBatch', {
      action: 'process',
      'runAt.$': '$.batch.runAt',
      'vendorId.$': '$.batch.vendorId',
      'distributorId.$': '$.batch.distributorId',
      'sources.$': '$.batch.sources',
    }, {
      // Not retried on timeout: the batch would spend its Firecrawl credits again.
      resultSelector: { 'stoppedBy.$': '$.stoppedBy', 'outcome.$': '$.outcome' },
      resultPath: '$.result',
    }).addCatch(markBatchFailed, { resultPath: '$.error' });
    processBatch.next(new sfn.Choice(this, 'AccountLevelError?')
      .when(sfn.Condition.and(
        sfn.Condition.isPresent('$.result.stoppedBy'),
        sfn.Condition.isNotNull('$.result.stoppedBy'),
      ), accountLevelStop)
      .otherwise(batchDone));

    const batches = new sfn.Map(this, 'Batches', {
      itemsPath: '$.plan.batches',
      maxConcurrency: this.batchConcurrency,
      itemSelector: { batch: sfn.JsonPath.objectAt('$$.Map.Item.Value') },
      resultPath: sfn.JsonPath.DISCARD,   // finalize reads update_log; keeps the state well under 256 KB
    }).itemProcessor(processBatch);

    const finalize = invoke('Finalize', { action: 'finalize', 'runAt.$': '$.plan.runAt', 'stop.$': '$.run.stop' }, {
      resultPath: '$.summary',
    }).addCatch(cleanup, catchAll);
    batches.addCatch(finalize, { errors: ['PriceSync.AccountLevelStop'], resultPath: '$.run.stop' });
    batches.addCatch(cleanup, catchAll);

    // ---- 3. Stop fck-nat if this execution started it; report the run. ----
    const succeeded = new sfn.Succeed(this, 'RunSucceeded');
    const noPrices = new sfn.Fail(this, 'NoPriceCollected', {
      error: 'PriceSync.NoPriceCollected',
      cause: 'No device price was collected in this run (no update_log row is success). See the run-summary log line.',
    });
    const checkResult = new sfn.Choice(this, 'AnyPriceCollected?')
      .when(sfn.Condition.booleanEquals('$.summary.successful', false), noPrices)
      .otherwise(succeeded);
    const stopNatAfterRun = this.stopNat('StopNat', props.natInstanceId, natArn)
      .addCatch(natNotStopped, { resultPath: '$.stopError' });
    stopNatAfterRun.next(checkResult);
    const stopIfStarted = new sfn.Choice(this, 'StartedNat?')
      .when(sfn.Condition.booleanEquals('$.run.startedNat', true), stopNatAfterRun)
      .otherwise(checkResult);

    // ---- Wiring. ----
    probe.next(plan).next(batches);
    batches.next(finalize);
    finalize.next(stopIfStarted);

    describeNat.next(new sfn.Choice(this, 'NatState?')
      .when(sfn.Condition.stringEquals('$.nat.state', 'running'), probe)
      .when(sfn.Condition.and(
        sfn.Condition.stringEquals('$.nat.state', 'stopped'),
        sfn.Condition.booleanEquals('$.run.startedNat', false),
      ), startNat)
      .when(sfn.Condition.or(
        sfn.Condition.stringEquals('$.nat.state', 'pending'),
        sfn.Condition.stringEquals('$.nat.state', 'stopping'),
        sfn.Condition.stringEquals('$.nat.state', 'stopped'),   // started by this run and not up yet
      ), countPoll)
      .otherwise(new sfn.Pass(this, 'NatUnusable', {
        parameters: { Error: 'PriceSync.NatUnusable', 'Cause.$': "States.Format('fck-nat is {}.', $.nat.state)" },
        resultPath: '$.failure',
      }).next(cleanup)));
    startNat.next(markStarted).next(countPoll);
    countPoll.next(tooManyPolls);
    waitForNat.next(describeNat);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: '/aws/vendedlogs/states/aghm-nwp-price-sync',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(init.next(describeNat)),
      // Last resort only: an execution timeout is not catchable, so cleanup would not run (stop fck-nat by hand).
      timeout: cdk.Duration.hours(6),
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR, includeExecutionData: true },
    });

    // ---- Weekly schedule (manuscript: weekly). ----
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Lets EventBridge Scheduler start the weekly price sync (NWP-PRICE-011)',
    });
    this.stateMachine.grantStartExecution(schedulerRole);
    new scheduler.CfnSchedule(this, 'WeeklySchedule', {
      description: 'Weekly price synchronization (NWP-PRICE-011)',
      scheduleExpression: props.scheduleExpression ?? 'cron(0 2 ? * SUN *)',
      scheduleExpressionTimezone: props.scheduleTimezone ?? 'Asia/Manila',
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: this.stateMachine.stateMachineArn,
        roleArn: schedulerRole.roleArn,
        input: '{}',
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });
  }

  private stopNat(stateId: string, instanceId: string, natArn: string): sfn.TaskStateBase {
    return new tasks.CallAwsService(this, stateId, {
      service: 'ec2',
      action: 'stopInstances',
      parameters: { InstanceIds: [instanceId] },
      iamResources: [natArn],
      resultPath: sfn.JsonPath.DISCARD,
    }).addRetry({ errors: ['States.ALL'], interval: cdk.Duration.seconds(5), maxAttempts: 3, backoffRate: 2 });
  }
}
