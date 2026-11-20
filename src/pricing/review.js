'use strict';

// NWP-PRICE-006: manual review. There is no admin dashboard and no login (manuscript delimitations): a team
// member acting as administrator runs `npm run pricing:review` and `npm run pricing:set-manual`.
//
//   devicesInRun               devices with an update_log row in a run (finalize passes them to evaluateManualReview)
//   listDevicesNeedingReview   flagged devices with each distributor's row and latest update_log status/error
//   countDevicesNeedingReview  the number of flagged devices
//   buildRunSummary            the finalize step's run-summary line, including the flagged count (NWP-PRICE-011)

const { getRunResult } = require('./outcome');

/** Device ids with at least one update_log row in this run, ascending. */
async function devicesInRun(client, runAt) {
  const { rows } = await client.query(
    'SELECT DISTINCT device_id FROM update_log WHERE run_at = $1 ORDER BY device_id',
    [runAt],
  );
  return rows.map((row) => Number(row.device_id));
}

async function countDevicesNeedingReview(client) {
  const { rows } = await client.query(
    'SELECT COUNT(DISTINCT device_id)::int AS count FROM pricing WHERE needs_manual_review',
  );
  return Number(rows[0].count);
}

/**
 * Every flagged device, with each distributor's pricing row and its latest update_log status and error.
 *
 * @returns {Promise<Array<{ deviceId: number, vendor: string, sku: string, name: string,
 *   price: string | null, priceUpdatedAt: Date | null,
 *   distributors: Array<{ distributorId: number, distributor: string, price: string, manual: boolean,
 *     isStale: boolean, consecutiveFailures: number, latestStatus: string | null, latestError: string | null,
 *     latestRunAt: Date | null }> }>>}  sorted by vendor, then SKU
 */
async function listDevicesNeedingReview(client) {
  const { rows: devices } = await client.query(
    `SELECT d.device_id, v.name AS vendor, d.sku, d.name, d.price, d.price_updated_at
       FROM device AS d
       JOIN vendor AS v ON v.vendor_id = d.vendor_id
      WHERE EXISTS (SELECT 1 FROM pricing AS p WHERE p.device_id = d.device_id AND p.needs_manual_review)
      ORDER BY v.name, d.sku`,
  );
  if (devices.length === 0) return [];

  const { rows: lines } = await client.query(
    `SELECT p.device_id, p.distributor_id, dist.name AS distributor, p.price, p.source_id, p.is_stale,
            p.consecutive_failure_count, latest.status, latest.error, latest.run_at
       FROM pricing AS p
       JOIN distributor AS dist ON dist.distributor_id = p.distributor_id
       LEFT JOIN LATERAL (
         SELECT u.status, u.error, u.run_at
           FROM update_log AS u
          WHERE u.device_id = p.device_id
            AND u.distributor_id = p.distributor_id
          ORDER BY u.run_at DESC, u.upd_log_id DESC
          LIMIT 1
       ) AS latest ON TRUE
      WHERE p.device_id = ANY($1::int[])
      ORDER BY p.device_id, dist.name`,
    [devices.map((d) => d.device_id)],
  );

  const byDevice = new Map();
  lines.forEach((row) => {
    const id = Number(row.device_id);
    if (!byDevice.has(id)) byDevice.set(id, []);
    byDevice.get(id).push({
      distributorId: Number(row.distributor_id),
      distributor: row.distributor,
      price: row.price === null ? null : String(row.price),
      manual: row.source_id === null,
      isStale: row.is_stale === true,
      consecutiveFailures: Number(row.consecutive_failure_count),
      latestStatus: row.status || null,
      latestError: row.error || null,
      latestRunAt: row.run_at || null,
    });
  });

  return devices.map((d) => ({
    deviceId: Number(d.device_id),
    vendor: d.vendor,
    sku: d.sku,
    name: d.name,
    price: d.price === null ? null : String(d.price),
    priceUpdatedAt: d.price_updated_at || null,
    distributors: byDevice.get(Number(d.device_id)) || [],
  }));
}

/**
 * The finalize step's run summary (NWP-PRICE-011 logs it as one JSON line).
 * @returns {Promise<{ source: string, event: string, runAt: string, successful: boolean, rows: number,
 *   byStatus: Record<string, number>, devicesNeedingReview: number }>}
 */
async function buildRunSummary(client, runAt) {
  const result = await getRunResult(client, runAt);
  const devicesNeedingReview = await countDevicesNeedingReview(client);
  return { source: 'price-updater', event: 'run-summary', ...result, devicesNeedingReview };
}

module.exports = {
  devicesInRun,
  countDevicesNeedingReview,
  listDevicesNeedingReview,
  buildRunSummary,
};