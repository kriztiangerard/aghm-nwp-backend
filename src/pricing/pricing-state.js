'use strict';

// NWP-PRICE-005 / 006: the sync state of pricing rows.
//
//   markSyncSuccess      after a new price is stored: not stale, failure count back to 0.        (005, 006)
//   markSyncFailure      when a sync attempt for the pair fails: stale, failure count + 1; the price, source
//                        and date are left exactly as they were, so the last verified price stays usable. (005, 006)
//   evaluateManualReview at finalize: a device needs manual review when EVERY one of its synchronized rows
//                        has failed MANUAL_REVIEW_THRESHOLD consecutive cycles, and it has no manual
//                        price (a manual price clears the flag).                                   (006)
//
// None of these inserts or deletes. Manual rows (source_id NULL) are never marked stale, never counted and
// never flagged. A device counts as stale for the engine only when ALL its rows are stale
// (price-provenance.js, NWP-ENGINE-006).
//
// All run on the caller's client, inside the caller's transaction:
//   - markSyncSuccess: right after upsertSynchronizedPrice() (collect.js, NWP-PRICE-002)
//   - markSyncFailure: for every non-success outcome (recordBatchOutcome, outcome.js, NWP-PRICE-004)
//   - evaluateManualReview: the finalize step (NWP-PRICE-011) and the manual-price script

const { MANUAL_REVIEW_THRESHOLD } = require('./constants');

function checkPair(name, pair) {
  const { deviceId, distributorId } = pair || {};
  if (!Number.isInteger(deviceId) || !Number.isInteger(distributorId)) {
    throw new TypeError(`${name}: deviceId and distributorId must be integers.`);
  }
  return { deviceId, distributorId };
}

/**
 * Marks the synchronized row of this pair stale and counts the failure, in one statement.
 * No row, or a manual row: nothing changes.
 *
 * @param {{ query: Function }} client
 * @param {{ deviceId: number, distributorId: number }} pair
 * @returns {Promise<{ updated: boolean, consecutiveFailures: number | null }>}
 */
async function markSyncFailure(client, pair) {
  const { deviceId, distributorId } = checkPair('markSyncFailure', pair);
  const { rowCount, rows } = await client.query(
    `UPDATE pricing
        SET is_stale = TRUE,
            consecutive_failure_count = consecutive_failure_count + 1
      WHERE device_id = $1
        AND distributor_id = $2
        AND source_id IS NOT NULL
      RETURNING consecutive_failure_count`,
    [deviceId, distributorId],
  );
  return {
    updated: rowCount > 0,
    consecutiveFailures: rows && rows[0] ? Number(rows[0].consecutive_failure_count) : null,
  };
}

/**
 * Clears the stale flag and resets the failure count of this pair's row, which was just stored with a new price.
 * The review flag is re-evaluated at finalize (evaluateManualReview), per device.
 *
 * @param {{ query: Function }} client
 * @param {{ deviceId: number, distributorId: number }} pair
 * @returns {Promise<{ updated: boolean }>}
 */
async function markSyncSuccess(client, pair) {
  const { deviceId, distributorId } = checkPair('markSyncSuccess', pair);
  const { rowCount } = await client.query(
    `UPDATE pricing
        SET is_stale = FALSE,
            consecutive_failure_count = 0
      WHERE device_id = $1
        AND distributor_id = $2`,
    [deviceId, distributorId],
  );
  return { updated: rowCount > 0 };
}

/**
 * For each device, sets needs_manual_review on all its synchronized rows to whether EVERY synchronized row has
 * reached the threshold. A device with one row below the threshold is not flagged, even if others reached it.
 * A device with a manual price (any row with source_id NULL) is never flagged: the manual price is the
 * administrator's review, so it clears the flag and keeps it clear while that manual row exists. A later
 * successful scrape replaces the manual row, and the normal rule applies again.
 * Idempotent: running it twice gives the same result. Devices with no synchronized rows are left alone.
 *
 * @param {{ query: Function }} client
 * @param {number[]} deviceIds  the devices processed in the run (devicesInRun, review.js)
 * @param {{ threshold?: number }} [options]
 * @returns {Promise<{ flagged: number[], notFlagged: number[] }>}  ascending device ids
 */
async function evaluateManualReview(client, deviceIds, { threshold = MANUAL_REVIEW_THRESHOLD } = {}) {
  if (!Array.isArray(deviceIds) || deviceIds.some((id) => !Number.isInteger(id))) {
    throw new TypeError('evaluateManualReview: deviceIds must be an array of integers.');
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new TypeError('evaluateManualReview: threshold must be a positive integer.');
  }
  if (deviceIds.length === 0) return { flagged: [], notFlagged: [] };

  const { rows } = await client.query(
    `WITH decision AS (
       SELECT device_id,
              bool_and(consecutive_failure_count >= $2) FILTER (WHERE source_id IS NOT NULL)
                AND NOT bool_or(source_id IS NULL) AS needs_review
         FROM pricing
        WHERE device_id = ANY($1::int[])
        GROUP BY device_id
       HAVING bool_or(source_id IS NOT NULL)
     )
     UPDATE pricing AS p
        SET needs_manual_review = decision.needs_review
       FROM decision
      WHERE p.device_id = decision.device_id
        AND p.source_id IS NOT NULL
     RETURNING p.device_id, decision.needs_review`,
    [[...new Set(deviceIds)], threshold],
  );

  const flagged = new Set();
  const notFlagged = new Set();
  rows.forEach((row) => (row.needs_review ? flagged : notFlagged).add(Number(row.device_id)));
  const sorted = (set) => [...set].sort((a, b) => a - b);
  return { flagged: sorted(flagged), notFlagged: sorted(notFlagged) };
}

module.exports = {
  markSyncFailure,
  markSyncSuccess,
  evaluateManualReview,
};