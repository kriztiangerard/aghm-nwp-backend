'use strict';

// NWP-PRICE-006: enter a verified price by hand (npm run pricing:set-manual).
//
// The row for that device and distributor is stored as a MANUAL price (source_id NULL): inserted, or replacing
// whatever was there, including a synchronized row. Its stale, failure-count and review state are cleared, the
// device's review flag is re-evaluated, and its median price is recalculated (NWP-PRICE-008).
// A later successful scrape for the same pair replaces the manual row again (NWP-PRICE-002).

const { parsePrice } = require('./price-formats');
const { normalizeSku } = require('./normalize-record');
const { evaluateManualReview } = require('./pricing-state');

class ManualPriceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManualPriceError';
  }
}

/** The device with this SKU under this vendor (SKUs are unique per vendor; matched like a scrape). */
async function findDevice(client, vendorName, sku) {
  const { rows } = await client.query(
    `SELECT d.device_id, d.sku, d.name, v.vendor_id, v.name AS vendor
       FROM device AS d
       JOIN vendor AS v ON v.vendor_id = d.vendor_id
      WHERE lower(btrim(v.name)) = lower(btrim($1))`,
    [vendorName],
  );
  if (rows.length === 0) throw new ManualPriceError(`No vendor named "${vendorName}" has devices.`);
  const wanted = normalizeSku(sku);
  const matches = rows.filter((row) => normalizeSku(row.sku) === wanted);
  if (matches.length === 0) throw new ManualPriceError(`${rows[0].vendor} has no device with SKU "${sku}".`);
  if (matches.length > 1) throw new ManualPriceError(`${rows[0].vendor} has ${matches.length} devices with SKU "${sku}".`);
  return matches[0];
}

async function findDistributor(client, distributorId) {
  const { rows } = await client.query('SELECT distributor_id, name FROM distributor WHERE distributor_id = $1', [distributorId]);
  if (rows.length === 0) throw new ManualPriceError(`No distributor with id ${distributorId}.`);
  return rows[0];
}

/**
 * Run inside one transaction (the caller's client).
 *
 * @param {{ query: Function }} client
 * @param {{ vendor: string, sku: string, distributorId: number, price: string }} input
 * @param {Object} [deps]
 * @param {Function|null} [deps.refreshMedians]  async (client, deviceIds) => refreshDeviceMedians result
 *   (NWP-PRICE-008). null: the device price is not recalculated (tests).
 * @param {Function} [deps.now]  () => Date, stored as last_updated (when the price was verified)
 * @returns {Promise<{ deviceId: number, vendor: string, sku: string, name: string, distributorId: number,
 *   distributor: string, price: string, replaced: 'inserted' | 'manual' | 'synchronized',
 *   stillNeedsReview: boolean, medianRefreshed: boolean, devicePrice: string | null }>}  devicePrice: the new median
 */
async function setManualPrice(client, input, { refreshMedians = null, now = () => new Date() } = {}) {
  const { vendor, sku, distributorId, price } = input || {};
  if (typeof vendor !== 'string' || !vendor.trim()) throw new ManualPriceError('--vendor is required.');
  if (typeof sku !== 'string' || !sku.trim()) throw new ManualPriceError('--sku is required.');
  if (!Number.isInteger(distributorId) || distributorId < 1) throw new ManualPriceError('--distributor must be a distributor id.');

  const parsed = parsePrice(price);
  if (!parsed.ok) throw new ManualPriceError(`--price is not usable: ${parsed.detail}`);

  const device = await findDevice(client, vendor, sku);
  const distributor = await findDistributor(client, distributorId);
  const deviceId = Number(device.device_id);

  const { rows: before } = await client.query(
    'SELECT source_id FROM pricing WHERE device_id = $1 AND distributor_id = $2',
    [deviceId, distributorId],
  );

  // pricing_id is never passed: it has an identity default (NWP-PRICE-009).
  await client.query(
    `INSERT INTO pricing (device_id, distributor_id, source_id, price, last_updated,
                          is_stale, consecutive_failure_count, needs_manual_review)
     VALUES ($1, $2, NULL, $3, $4, FALSE, 0, FALSE)
     ON CONFLICT (device_id, distributor_id) DO UPDATE
        SET source_id = NULL,
            price = EXCLUDED.price,
            last_updated = EXCLUDED.last_updated,
            is_stale = FALSE,
            consecutive_failure_count = 0,
            needs_manual_review = FALSE`,
    [deviceId, distributorId, parsed.decimal, now()],
  );

  const review = await evaluateManualReview(client, [deviceId]);
  let medianRefreshed = false;
  let devicePrice = null;
  if (typeof refreshMedians === 'function') {
    const refreshed = await refreshMedians(client, [deviceId]);
    medianRefreshed = true;
    const entry = refreshed && Array.isArray(refreshed.updated) ? refreshed.updated.find((u) => u.deviceId === deviceId) : null;
    devicePrice = entry ? entry.price : null;
  }

  return {
    deviceId,
    vendor: device.vendor,
    sku: device.sku,
    name: device.name,
    distributorId,
    distributor: distributor.name,
    price: parsed.decimal,
    replaced: before.length === 0 ? 'inserted' : (before[0].source_id === null ? 'manual' : 'synchronized'),
    stillNeedsReview: review.flagged.includes(deviceId),
    medianRefreshed,
    devicePrice,
  };
}

module.exports = {
  setManualPrice,
  findDevice,
  ManualPriceError,
};