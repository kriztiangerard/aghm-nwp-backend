'use strict';

// NWP-PRICE-008: each device's catalog price (device.price, read by the engine and the BOM) is the median of
// its distributor prices, so one unusual price (a promotion, a stockout, a scraping error) doesn't distort it.
//
//   Fresh rows   synchronized rows that aren't stale, and manual rows (source_id NULL; never stale).
//   Option       includeStale (PRICE_MEDIAN_INCLUDE_STALE, default false): stale synchronized rows join the
//                median too, but only when the device has at least one fresh row.
//   No fresh row device.price and price_updated_at are left exactly as they are, whatever the option.
//   No rows      nothing is written; a NULL price stays NULL (no price is made up).
//   Arithmetic   integer centavos only; an even count takes the mean of the two middle values, half-up.
//
// Runs in the finalize step (NWP-PRICE-011) for the devices processed in the run, and from
// npm run pricing:set-manual for the one device it changed (NWP-PRICE-006).

/**
 * Pure median of integer centavo amounts.
 * @param {number[]} centavosList  non-negative safe integers (order doesn't matter)
 * @returns {number | null}  centavos, or null for an empty list
 */
function computeMedian(centavosList) {
  if (!Array.isArray(centavosList)) throw new TypeError('computeMedian: expected an array of centavos.');
  if (centavosList.some((c) => !Number.isSafeInteger(c) || c < 0)) {
    throw new TypeError('computeMedian: every value must be a non-negative integer number of centavos.');
  }
  if (centavosList.length === 0) return null;

  const sorted = [...centavosList].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  // Mean of the two middle values, rounded half-up to the centavo. Written as a + floor((b - a + 1) / 2), which
  // equals floor((a + b + 1) / 2) for 0 <= a <= b but never adds a and b, so it stays exact for every safe
  // integer (a + b can pass Number.MAX_SAFE_INTEGER; b - a + 1 is at most 2^53, which is still exact).
  const a = sorted[mid - 1];
  const b = sorted[mid];
  return a + Math.floor((b - a + 1) / 2);
}

/**
 * Exact conversion of a DECIMAL value from pg (a string such as "3500", "3500.5", "3500.50") to centavos.
 * More than two decimals are rounded half-up (pricing.price has no fixed scale).
 * @returns {number}
 */
function decimalToCentavos(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError(`decimalToCentavos: "${value}" is not a non-negative decimal amount.`);
  const fraction = match[2] || '';
  let centavos = Number(match[1]) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  if (fraction.length > 2 && Number(fraction[2]) >= 5) centavos += 1;
  if (!Number.isSafeInteger(centavos)) throw new TypeError(`decimalToCentavos: "${value}" is too large.`);
  return centavos;
}

/** Two-decimal string for a DECIMAL column, e.g. 345050 -> "3450.50". */
function centavosToDecimal(centavos) {
  return `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, '0')}`;
}

/**
 * Pure: which prices make up one device's median.
 * @param {Array<{ price: string|number, source_id: number|null, is_stale: boolean }>} rows  the device's pricing rows
 * @param {{ includeStale?: boolean }} [options]
 * @returns {{ centavos: number | null, used: number, fresh: number }}  centavos null = leave the device unchanged
 */
function medianForRows(rows, { includeStale = false } = {}) {
  const isManual = (row) => row.source_id === null || row.source_id === undefined;
  const fresh = rows.filter((row) => isManual(row) || row.is_stale !== true);
  if (fresh.length === 0) return { centavos: null, used: 0, fresh: 0 };
  const used = includeStale ? rows : fresh;   // with includeStale, stale synchronized rows join the fresh ones
  return { centavos: computeMedian(used.map((row) => decimalToCentavos(row.price))), used: used.length, fresh: fresh.length };
}

/**
 * Recalculates device.price for these devices (run on the caller's client, inside its transaction).
 *
 * @param {{ query: Function }} client
 * @param {number[]} deviceIds  the devices processed in the run
 * @param {{ includeStale?: boolean, updatedAt?: Date | string }} [options]
 *   includeStale: PRICE_MEDIAN_INCLUDE_STALE (loadPricingConfig().medianIncludeStale); default false
 *   updatedAt: written to price_updated_at; the run time (runAt) at finalize, default now
 * @returns {Promise<{ updated: Array<{ deviceId: number, price: string, prices: number }>, unchanged: number[] }>}
 *   unchanged: devices with no fresh row (or no rows at all), left exactly as they were
 */
async function refreshDeviceMedians(client, deviceIds, { includeStale = false, updatedAt = new Date() } = {}) {
  if (!Array.isArray(deviceIds) || deviceIds.some((id) => !Number.isInteger(id))) {
    throw new TypeError('refreshDeviceMedians: deviceIds must be an array of integers.');
  }
  if (typeof includeStale !== 'boolean') throw new TypeError('refreshDeviceMedians: includeStale must be a boolean.');
  // price_updated_at is sent as a UTC ISO string, never a Date: node-pg sends a Date in the machine's local
  // time, and the TIMESTAMP column (no time zone) would keep PH time from a laptop but UTC from the Lambda.
  const updatedAtDate = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(updatedAtDate.getTime())) {
    throw new TypeError('refreshDeviceMedians: updatedAt must be a valid Date or ISO date string.');
  }
  const updatedAtUtc = updatedAtDate.toISOString();
  const ids = [...new Set(deviceIds)].sort((a, b) => a - b);
  if (ids.length === 0) return { updated: [], unchanged: [] };

  const { rows } = await client.query(
    `SELECT device_id, price, source_id, is_stale
       FROM pricing
      WHERE device_id = ANY($1::int[])
      ORDER BY device_id, distributor_id`,
    [ids],
  );
  const byDevice = new Map(ids.map((id) => [id, []]));
  rows.forEach((row) => byDevice.get(Number(row.device_id)).push(row));

  const updated = [];
  const unchanged = [];
  for (const deviceId of ids) {
    const { centavos, used } = medianForRows(byDevice.get(deviceId), { includeStale });
    if (centavos === null) {
      unchanged.push(deviceId);
      continue;
    }
    const price = centavosToDecimal(centavos);
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      'UPDATE device SET price = $2, price_updated_at = $3 WHERE device_id = $1',
      [deviceId, price, updatedAtUtc],
    );
    updated.push({ deviceId, price, prices: used });
  }
  return { updated, unchanged };
}

module.exports = {
  computeMedian,
  decimalToCentavos,
  centavosToDecimal,
  medianForRows,
  refreshDeviceMedians,
};