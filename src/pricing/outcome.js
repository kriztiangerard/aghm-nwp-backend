'use strict';

// NWP-PRICE-004: turns a batch summary (collect.js) into one outcome per device and records it.
//
// Attribution, per batch (one vendor and one distributor):
//   - found with a usable price and stored          -> success
//   - found, but storing failed                      -> db_error
//   - found, but the price can't be used             -> the rejection reason (invalid_price, missing_field)
//   - tracked, not found, last priced from a page that FAILED     -> that page's status (blocked, timeout, …)
//   - tracked, not found, last priced from a page that SUCCEEDED  -> not_listed
//   - never priced from this distributor and not found            -> nothing is recorded
//
// "Tracked" = the distributor's synchronized rows (source_id set) for the vendor's devices whose source is
// one of the batch's pages. Manual rows (source_id NULL) are never tracked.
//
// When the batch stopped on an account-level error (stoppedBy), devices that were not found are NOT
// attributed: that failure isn't the distributor's, so nothing is marked failed for it.
//
// Every non-success gets markSyncFailure() (NWP-PRICE-005, which marks the row stale; 006 counts it).

const { SYNC_STATUS, fromRejectReason } = require('./sync-status');

/**
 * Synchronized rows of this distributor for the vendor's devices, priced from one of these pages.
 * @returns {Promise<Array<{ deviceId: number, sourceId: number }>>}
 */
async function loadTrackedRows(client, { vendorId, distributorId, sourceIds }) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT p.device_id, p.source_id
       FROM pricing AS p
       JOIN device AS d ON d.device_id = p.device_id
      WHERE p.distributor_id = $1
        AND d.vendor_id = $2
        AND p.source_id = ANY($3::int[])
      ORDER BY p.device_id`,
    [distributorId, vendorId, sourceIds],
  );
  return rows.map((row) => ({ deviceId: Number(row.device_id), sourceId: Number(row.source_id) }));
}

/**
 * Pure: decides one outcome per device.
 *
 * @param {import('./collect').BatchSummary} summary
 * @param {Array<{ deviceId: number, sourceId: number }>} trackedRows
 * @returns {Array<{ deviceId: number, status: string, error: string | null }>} sorted by deviceId
 */
function attributeOutcomes(summary, trackedRows) {
  const outcomes = new Map();

  (summary.found || []).forEach((deviceId) => outcomes.set(deviceId, { status: SYNC_STATUS.SUCCESS, error: null }));
  (summary.dbErrors || []).forEach(({ deviceId, detail }) => {
    outcomes.set(deviceId, { status: SYNC_STATUS.DB_ERROR, error: detail });
  });
  (summary.rejected || []).forEach(({ deviceId, reason, detail }) => {
    if (!outcomes.has(deviceId)) outcomes.set(deviceId, { status: fromRejectReason(reason), error: detail || null });
  });

  if (!summary.stoppedBy) {
    const pages = new Map((summary.pages || []).map((page) => [page.sourceId, page]));
    trackedRows.forEach(({ deviceId, sourceId }) => {
      if (outcomes.has(deviceId)) return;
      const page = pages.get(sourceId);
      if (!page || page.status === 'skipped') return;   // page not scraped: nothing to say
      if (page.status === SYNC_STATUS.SUCCESS) {
        outcomes.set(deviceId, {
          status: SYNC_STATUS.NOT_LISTED,
          error: `No longer listed on any page of this distributor (last priced from source ${sourceId}).`,
        });
      } else {
        outcomes.set(deviceId, {
          status: page.status,
          error: `Source ${sourceId} failed: ${page.message || page.status}`,
        });
      }
    });
  }

  return [...outcomes.entries()]
    .map(([deviceId, outcome]) => ({ deviceId, ...outcome }))
    .sort((a, b) => a.deviceId - b.deviceId);
}

/**
 * Writes one update_log row per device of the batch and calls markSyncFailure() for every non-success.
 * Run it inside one transaction (the caller's client). Never passes upd_log_id (identity default, 009).
 *
 * @param {{ query: Function }} client
 * @param {import('./collect').BatchSummary} summary
 * @param {{ markSyncFailure?: Function }} [deps]  async (client, { deviceId, distributorId }); NWP-PRICE-005
 * @returns {Promise<{ recorded: number, byStatus: Record<string, number> }>}
 */
async function recordBatchOutcome(client, summary, {
  // NWP-PRICE-005 provides the real markSyncFailure (marks the row stale); until then failures are only logged.
  markSyncFailure = async () => {},
} = {}) {
  const sourceIds = (summary.pages || []).map((page) => page.sourceId);
  const tracked = await loadTrackedRows(client, {
    vendorId: summary.vendorId, distributorId: summary.distributorId, sourceIds,
  });
  const outcomes = attributeOutcomes(summary, tracked);

  const byStatus = {};
  for (const { deviceId, status, error } of outcomes) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO update_log (distributor_id, device_id, status, error, run_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [summary.distributorId, deviceId, status, error, summary.runAt],
    );
    if (status !== SYNC_STATUS.SUCCESS) {
      // eslint-disable-next-line no-await-in-loop
      await markSyncFailure(client, { deviceId, distributorId: summary.distributorId });
    }
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return { recorded: outcomes.length, byStatus };
}

/**
 * A run is successful if at least one update_log row with that run_at is `success` (decision 7).
 * Called by the finalize step (NWP-PRICE-011).
 *
 * @returns {Promise<{ runAt: string, successful: boolean, rows: number, byStatus: Record<string, number> }>}
 */
async function getRunResult(client, runAt) {
  const { rows } = await client.query(
    `SELECT status, COUNT(*)::int AS count
       FROM update_log
      WHERE run_at = $1
      GROUP BY status
      ORDER BY status`,
    [runAt],
  );
  const byStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  return { runAt, successful: (byStatus[SYNC_STATUS.SUCCESS] || 0) > 0, rows: total, byStatus };
}

module.exports = {
  loadTrackedRows,
  attributeOutcomes,
  recordBatchOutcome,
  getRunResult,
};