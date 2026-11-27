'use strict';

// NWP-PRICE-011: the weekly workflow's own steps. The Step Functions state machine (lib/aghm-nwp-stack.ts)
// invokes the Price updater Lambda with these actions around the per-batch `process` action:
//
//   plan             active sources grouped into vendor x distributor batches, all sharing the run's runAt
//   markBatchFailed  a batch whose `process` call failed as a whole (Lambda timeout, crash): its devices are
//                    recorded as unexpected_error and marked failed, so the run can go on
//   finalize         median prices (008), manual review (006), and the run result with its summary line (004)
//
// Every function takes a pg client, so the handler decides the transaction.

const { listActiveSources } = require('./sources');
const { SYNC_STATUS } = require('./sync-status');
const { markSyncFailure: markSyncFailureInDb, evaluateManualReview } = require('./pricing-state');
const { refreshDeviceMedians } = require('./median');
const { devicesInRun, buildRunSummary } = require('./review');

const ERROR_TEXT_LIMIT = 500;   // update_log.error stays readable in pricing:review

class InvalidWorkflowInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidWorkflowInputError';
  }
}

function checkRunAt(name, runAt) {
  if (typeof runAt !== 'string' || Number.isNaN(new Date(runAt).getTime())) {
    throw new InvalidWorkflowInputError(`${name}: runAt must be an ISO date string (the execution start time).`);
  }
  return runAt;
}

/**
 * Pure: groups sources into one batch per vendor and distributor, in a stable order.
 *
 * @param {Array<{ sourceId: number, sourceUrl: string, vendorId: number, distributorId: number }>} sources
 * @param {string} runAt
 * @returns {Array<{ runAt: string, vendorId: number, distributorId: number,
 *   sources: Array<{ sourceId: number, sourceUrl: string }> }>}  sorted by vendorId, then distributorId
 */
function groupIntoBatches(sources, runAt) {
  const batches = new Map();
  sources.forEach(({ sourceId, sourceUrl, vendorId, distributorId }) => {
    const key = `${vendorId}:${distributorId}`;
    if (!batches.has(key)) batches.set(key, { runAt, vendorId, distributorId, sources: [] });
    batches.get(key).sources.push({ sourceId, sourceUrl });
  });
  return [...batches.values()]
    .map((batch) => ({ ...batch, sources: batch.sources.sort((a, b) => a.sourceId - b.sourceId) }))
    .sort((a, b) => a.vendorId - b.vendorId || a.distributorId - b.distributorId);
}

/**
 * The `plan` action. runAt is $$.Execution.StartTime, so every batch of the run shares it.
 *
 * @returns {Promise<{ runAt: string, batchCount: number, sourceCount: number, batches: ReturnType<typeof groupIntoBatches> }>}
 */
async function planRun(client, { runAt } = {}) {
  checkRunAt('plan', runAt);
  const sources = await listActiveSources(client);
  const batches = groupIntoBatches(sources, runAt);
  return { runAt, batchCount: batches.length, sourceCount: sources.length, batches };
}

/** Readable text for update_log.error from a Step Functions Catch ({ Error, Cause }). */
function describeBatchError(error) {
  const name = (error && typeof error.Error === 'string' && error.Error) || 'UnknownError';
  let detail = error && typeof error.Cause === 'string' ? error.Cause : '';
  try {
    const cause = JSON.parse(detail);   // a Lambda error's Cause is JSON: { errorType, errorMessage, ... }
    if (cause && typeof cause.errorMessage === 'string') detail = cause.errorMessage;
  } catch (parseError) {
    // not JSON (for example States.Timeout): keep the text as it is
  }
  const text = `Batch failed as a whole (${name})${detail ? `: ${detail}` : ''}`;
  return text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT - 1)}…` : text;
}

/**
 * The `markBatchFailed` action, run when a batch's `process` call failed as a whole.
 *
 * Attribution is NWP-PRICE-004's: the distributor's synchronized rows for the vendor's devices last priced
 * from one of the batch's pages. Of those:
 *   - already recorded in this run (the batch got as far as recordBatchOutcome): left alone, so this is
 *     safe to run twice;
 *   - stored during this run (last_updated at or after runAt and not stale): recorded as success. The
 *     collection step only stores a price after every page is read and combined, so it is correct;
 *   - the rest: recorded as unexpected_error and marked failed (markSyncFailure: stale, count + 1).
 *
 * @param {{ query: Function }} client
 * @param {{ batch: { runAt: string, vendorId: number, distributorId: number, sources: Array<{ sourceId: number }> },
 *   error?: { Error?: string, Cause?: string } }} input
 * @param {{ markSyncFailure?: Function }} [deps]
 * @returns {Promise<{ vendorId: number, distributorId: number, recorded: number,
 *   byStatus: Record<string, number>, alreadyRecorded: boolean }>}
 */
async function markBatchFailed(client, input, { markSyncFailure = markSyncFailureInDb } = {}) {
  const { batch, error } = input || {};
  if (!batch || typeof batch !== 'object') throw new InvalidWorkflowInputError('markBatchFailed: batch is required.');
  const { runAt, vendorId, distributorId, sources } = batch;
  checkRunAt('markBatchFailed', runAt);
  if (!Number.isInteger(vendorId) || !Number.isInteger(distributorId)) {
    throw new InvalidWorkflowInputError('markBatchFailed: vendorId and distributorId must be integers.');
  }
  const sourceIds = (Array.isArray(sources) ? sources : []).map((s) => s && s.sourceId).filter(Number.isInteger);
  const result = { vendorId, distributorId, recorded: 0, byStatus: {}, alreadyRecorded: false };
  if (sourceIds.length === 0) return result;

  const { rows } = await client.query(
    `SELECT p.device_id,
            (p.last_updated >= $4::timestamp AND NOT p.is_stale) AS stored_this_run,
            EXISTS (SELECT 1 FROM update_log AS u
                     WHERE u.run_at = $4::timestamp
                       AND u.distributor_id = p.distributor_id
                       AND u.device_id = p.device_id) AS recorded
       FROM pricing AS p
       JOIN device AS d ON d.device_id = p.device_id
      WHERE p.distributor_id = $1
        AND d.vendor_id = $2
        AND p.source_id = ANY($3::int[])
      ORDER BY p.device_id`,
    [distributorId, vendorId, sourceIds, runAt],
  );

  const detail = describeBatchError(error);
  for (const row of rows) {
    if (row.recorded === true) {
      result.alreadyRecorded = true;
      continue;
    }
    const deviceId = Number(row.device_id);
    const stored = row.stored_this_run === true;
    const status = stored ? SYNC_STATUS.SUCCESS : SYNC_STATUS.UNEXPECTED_ERROR;
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO update_log (distributor_id, device_id, status, error, run_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [distributorId, deviceId, status, stored ? null : detail, runAt],
    );
    if (!stored) {
      // eslint-disable-next-line no-await-in-loop
      await markSyncFailure(client, { deviceId, distributorId });
    }
    result.recorded += 1;
    result.byStatus[status] = (result.byStatus[status] || 0) + 1;
  }
  return result;
}

/** The account-level stop the Map caught ({ Error, Cause } with Cause = JSON of stoppedBy), or null. */
function readStop(stop) {
  if (!stop || typeof stop !== 'object') return null;
  try {
    const parsed = JSON.parse(stop.Cause);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (parseError) {
    // fall through
  }
  return { status: stop.Error || 'unknown', message: typeof stop.Cause === 'string' ? stop.Cause : null };
}

/**
 * The `finalize` action. Devices come from update_log (devicesInRun): every device a batch reported
 * (found, rejected, attributed, or recorded by markBatchFailed) has a row there with this runAt.
 *
 * Order: medians (008), manual review (006), then the run result (004). One summary line is logged.
 *
 * @param {{ query: Function }} client
 * @param {{ runAt: string, stop?: { Error?: string, Cause?: string } | null }} input
 * @param {{ includeStale?: boolean, logger?: { log: Function } }} [options]
 */
async function finalizeRun(client, input, { includeStale = false, logger = console } = {}) {
  const { runAt } = input || {};
  checkRunAt('finalize', runAt);
  const stoppedBy = readStop(input && input.stop);

  const deviceIds = await devicesInRun(client, runAt);
  const medians = await refreshDeviceMedians(client, deviceIds, { includeStale, updatedAt: runAt });   // stored as UTC (median.js)
  const review = await evaluateManualReview(client, deviceIds);
  const summary = await buildRunSummary(client, runAt);
  const unrecorded = await findUnrecordedOutcomes(client, runAt);
  const unrecordedDevices = unrecorded.reduce((sum, group) => sum + group.devices, 0);

  const line = {
    ...summary,
    devices: deviceIds.length,
    mediansUpdated: medians.updated.length,
    mediansUnchanged: medians.unchanged.length,
    flaggedInRun: review.flagged.length,
    stoppedBy,
    // AC5: devices that should have an update_log row in this run and don't. After an account-level stop
    // these are the skipped batches (expected); otherwise a batch's failure was not recorded (for example
    // markBatchFailed itself failed) and the workflow ends Failed (PriceSync.OutcomesMissing).
    unrecordedDevices,
    unrecorded,
  };
  logger.log(JSON.stringify(line));
  if (unrecordedDevices > 0 && !stoppedBy) {
    logger.error(JSON.stringify({
      source: 'price-updater', event: 'outcomes-missing', runAt, unrecordedDevices, unrecorded,
      recovery: 'Run markBatchFailed for each listed vendor and distributor with this runAt, then finalize again (README: Price Updater: Weekly Sync, Recovery).',
    }));
  }
  return line;
}

const UNRECORDED_IDS_SHOWN = 20;   // per group in the log line; the count is always exact

/**
 * Devices last priced from an ACTIVE source (so they belong to one of this run's batches) with no update_log
 * row for this run and that distributor. Grouped by vendor and distributor, which is how batches are built,
 * so each group says exactly which batch to recover. Manual rows and inactive sources are left out.
 *
 * @returns {Promise<Array<{ vendorId: number, distributorId: number, devices: number, deviceIds: number[] }>>}
 */
async function findUnrecordedOutcomes(client, runAt) {
  const { rows } = await client.query(
    `SELECT s.vendor_id, p.distributor_id, count(*)::int AS devices,
            (array_agg(p.device_id ORDER BY p.device_id))[1:${UNRECORDED_IDS_SHOWN}] AS device_ids
       FROM pricing AS p
       JOIN pricing_source AS s ON s.source_id = p.source_id AND s.is_active
      WHERE NOT EXISTS (SELECT 1 FROM update_log AS u
                         WHERE u.run_at = $1::timestamp
                           AND u.device_id = p.device_id
                           AND u.distributor_id = p.distributor_id)
      GROUP BY s.vendor_id, p.distributor_id
      ORDER BY s.vendor_id, p.distributor_id`,
    [runAt],
  );
  return rows.map((row) => ({
    vendorId: Number(row.vendor_id),
    distributorId: Number(row.distributor_id),
    devices: Number(row.devices),
    deviceIds: (row.device_ids || []).map(Number),
  }));
}

module.exports = {
  groupIntoBatches,
  planRun,
  describeBatchError,
  markBatchFailed,
  readStop,
  finalizeRun,
  findUnrecordedOutcomes,
  InvalidWorkflowInputError,
};
