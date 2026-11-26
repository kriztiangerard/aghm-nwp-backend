'use strict';

// NWP-PRICE-010: Price updater Lambda entry point (`handler`, deployed by lib/aghm-nwp-stack.ts).
//
// The weekly Step Functions workflow (NWP-PRICE-011) invokes this one function with { action, ... }:
//
//   probe            check outbound internet access and that the Firecrawl key can be read   (NWP-PRICE-010)
//   plan             list active sources and group them into batches               (NWP-PRICE-011)
//   process          scrape and store one vendor x distributor batch, record outcomes (NWP-PRICE-002/004)
//   markBatchFailed  record a whole batch as failed after a crash or timeout        (NWP-PRICE-011)
//   finalize         medians, manual review, run result                             (NWP-PRICE-011)
//
// An unknown or missing action throws UnknownActionError. Each invocation writes one structured log line.

const { loadPricingConfig } = require('./config');
const { probeOutbound } = require('./probe');
const { getFirecrawlApiKey } = require('./firecrawl-secret');
const { processSourceBatch } = require('./collect');
const { recordBatchOutcome } = require('./outcome');
const { withTransaction } = require('./db');
const { planRun, markBatchFailed, finalizeRun } = require('./workflow');

const ACTIONS = Object.freeze({
  PROBE: 'probe',
  PLAN: 'plan',
  PROCESS: 'process',
  MARK_BATCH_FAILED: 'markBatchFailed',
  FINALIZE: 'finalize',
});

class UnknownActionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnknownActionError';
  }
}

const DEFAULT_ACTIONS = Object.freeze({
  // Outbound access first (a ProbeFailedError means fck-nat is not up yet, and the workflow retries), then the
  // Firecrawl key (a failure here is a setup problem, SecretUnavailableError, and is not retried). The key is not returned.
  [ACTIONS.PROBE]: async () => {
    const outbound = await probeOutbound();
    await getFirecrawlApiKey();
    // RDS last (AC1): no internet needed, so a failure here is a VPC or database problem, not fck-nat.
    const { probeDatabase } = require('./probe');   // required here so the import block above stays as later stories have it
    const database = await probeDatabase();
    return { ...outbound, firecrawlKey: 'readable', ...database };
  },
  // event: { action: 'plan', runAt }  (runAt: $$.Execution.StartTime). Returns { runAt, batchCount, sourceCount, batches }.
  [ACTIONS.PLAN]: async (event) => withTransaction((client) => planRun(client, event)),
  // event: { action: 'process', runAt, vendorId, distributorId, sources: [{ sourceId, sourceUrl }] }
  // Returns the batch summary plus `outcome` ({ recorded, byStatus }). `stoppedBy` is set when an
  // account-level error stopped the batch; the workflow then skips the remaining batches (NWP-PRICE-011).
  [ACTIONS.PROCESS]: async (event, { config }) => {
    const summary = await processSourceBatch(event, { concurrency: config.firecrawlConcurrency });
    const outcome = await withTransaction((client) => recordBatchOutcome(client, summary));
    return { ...summary, outcome };
  },
  // event: { action: 'markBatchFailed', batch: <the batch>, error: { Error, Cause } }  (the Map item's Catch)
  [ACTIONS.MARK_BATCH_FAILED]: async (event) => withTransaction((client) => markBatchFailed(client, event)),
  // event: { action: 'finalize', runAt, stop: null | { Error, Cause } }  (stop: the account-level stop the Map caught)
  [ACTIONS.FINALIZE]: async (event, { config }) => withTransaction(
    (client) => finalizeRun(client, event, { includeStale: config.medianIncludeStale }),
  ),
});

/**
 * Builds the handler. Later stories replace an action by passing it in `actions`; tests inject fakes.
 *
 * @param {Object} [options]
 * @param {Record<string, (event: object, context: { config: object }) => Promise<any>>} [options.actions]
 * @param {Record<string, string|undefined>} [options.env]   default: process.env
 * @param {{ log: Function, error: Function }} [options.logger] default: console
 * @param {Function} [options.now]                             clock in ms
 */
function createHandler({ actions = {}, env = process.env, logger = console, now = Date.now } = {}) {
  const table = { ...DEFAULT_ACTIONS, ...actions };
  const known = Object.keys(table);

  return async function handler(event) {
    const action = event && typeof event === 'object' ? event.action : undefined;
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(table, action)) {
      throw new UnknownActionError(`Unknown action ${JSON.stringify(action)}. Expected one of: ${known.join(', ')}.`);
    }

    const startedAt = now();
    try {
      const config = loadPricingConfig(env);
      const result = await table[action](event, { config });
      logger.log(JSON.stringify({ source: 'price-updater', action, ok: true, ms: now() - startedAt }));
      return result;
    } catch (error) {
      logger.error(JSON.stringify({
        source: 'price-updater', action, ok: false, ms: now() - startedAt,
        error: error && error.name, message: error && error.message,
      }));
      throw error;
    }
  };
}

module.exports = {
  handler: createHandler(),
  createHandler,
  ACTIONS,
  UnknownActionError,
  DEFAULT_ACTIONS_FOR_TEST: DEFAULT_ACTIONS,
};