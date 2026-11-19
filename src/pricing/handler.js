'use strict';

// NWP-PRICE-010: Price updater Lambda entry point (`handler`, deployed by lib/aghm-nwp-stack.ts).
//
// The weekly Step Functions workflow (NWP-PRICE-011) invokes this one function with { action, ... }:
//
//   probe            check outbound internet access before scraping                 (this story)
//   plan             list active sources and group them into batches               (NWP-PRICE-011)
//   process          scrape and store one vendor x distributor batch                (NWP-PRICE-002/004)
//   markBatchFailed  record a whole batch as failed after a crash or timeout        (NWP-PRICE-011)
//   finalize         medians, manual review, run result                             (NWP-PRICE-011)
//
// Actions not built yet throw NotImplementedError naming their story. An unknown or missing action
// throws UnknownActionError. Each invocation writes one structured log line.

const { loadPricingConfig } = require('./config');
const { probeOutbound } = require('./probe');

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

class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

function notImplemented(action, story) {
  return async () => {
    throw new NotImplementedError(`Action "${action}" is not implemented yet (${story}).`);
  };
}

const DEFAULT_ACTIONS = Object.freeze({
  [ACTIONS.PROBE]: async () => probeOutbound(),
  [ACTIONS.PLAN]: notImplemented(ACTIONS.PLAN, 'NWP-PRICE-011'),
  [ACTIONS.PROCESS]: notImplemented(ACTIONS.PROCESS, 'NWP-PRICE-002'),
  [ACTIONS.MARK_BATCH_FAILED]: notImplemented(ACTIONS.MARK_BATCH_FAILED, 'NWP-PRICE-011'),
  [ACTIONS.FINALIZE]: notImplemented(ACTIONS.FINALIZE, 'NWP-PRICE-011'),
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
  NotImplementedError,
};
