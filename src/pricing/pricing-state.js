'use strict';

// NWP-PRICE-005: staleness of one pricing row (one device at one distributor).
//
//   markSyncSuccess   after a new price is stored: the row is no longer stale.
//   markSyncFailure   when a sync attempt for the pair fails: the row is marked stale and otherwise left
//                     exactly as it was, so the last verified price stays usable.
//
// Both only UPDATE. Neither inserts nor deletes, and markSyncFailure never touches price, source_id or
// last_updated. Manual rows (source_id NULL) are never marked stale. A device counts as stale for the engine
// only when ALL its rows are stale (price-provenance.js, NWP-ENGINE-006), so a device with any manual or
// fresh row is never shown as stale.
//
// Both run on the caller's client, inside the caller's transaction:
//   - markSyncSuccess: right after upsertSynchronizedPrice() (collect.js, NWP-PRICE-002)
//   - markSyncFailure: for every non-success outcome (recordBatchOutcome, outcome.js, NWP-PRICE-004)
// NWP-PRICE-006 extends both with the consecutive failure count.

function checkPair(name, pair) {
  const { deviceId, distributorId } = pair || {};
  if (!Number.isInteger(deviceId) || !Number.isInteger(distributorId)) {
    throw new TypeError(`${name}: deviceId and distributorId must be integers.`);
  }
  return { deviceId, distributorId };
}

/**
 * Marks the synchronized row of this pair stale. No row, or a manual row: nothing changes.
 *
 * @param {{ query: Function }} client
 * @param {{ deviceId: number, distributorId: number }} pair
 * @returns {Promise<{ updated: boolean }>}  true when a synchronized row was marked stale
 */
async function markSyncFailure(client, pair) {
  const { deviceId, distributorId } = checkPair('markSyncFailure', pair);
  const { rowCount } = await client.query(
    `UPDATE pricing
        SET is_stale = TRUE
      WHERE device_id = $1
        AND distributor_id = $2
        AND source_id IS NOT NULL`,
    [deviceId, distributorId],
  );
  return { updated: rowCount > 0 };
}

/**
 * Clears the stale flag of this pair's row, which was just stored with a new price.
 *
 * @param {{ query: Function }} client
 * @param {{ deviceId: number, distributorId: number }} pair
 * @returns {Promise<{ updated: boolean }>}
 */
async function markSyncSuccess(client, pair) {
  const { deviceId, distributorId } = checkPair('markSyncSuccess', pair);
  const { rowCount } = await client.query(
    `UPDATE pricing
        SET is_stale = FALSE
      WHERE device_id = $1
        AND distributor_id = $2`,
    [deviceId, distributorId],
  );
  return { updated: rowCount > 0 };
}

module.exports = {
  markSyncFailure,
  markSyncSuccess,
};