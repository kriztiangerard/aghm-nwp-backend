'use strict';

// NWP-PRICE-002: the pricing sources and catalog the Price updater reads.
//
// CommonJS counterpart of the TypeScript getActiveDistributorSources() (NWP-PRICE-001), which returns
// vendor and distributor names for display; the updater needs ids. Every function takes a pg client
// (or pool), so it can run inside the caller's transaction.

const { buildSkuIndex } = require('./normalize-record');

/**
 * Active sources with a URL, ordered so each vendor x distributor batch is contiguous.
 *
 * @param {{ query: Function }} client
 * @returns {Promise<Array<{ sourceId: number, sourceUrl: string, vendorId: number, distributorId: number }>>}
 */
async function listActiveSources(client) {
  const { rows } = await client.query(
    `SELECT source_id, source_url, vendor_id, distributor_id
       FROM pricing_source
      WHERE is_active
        AND source_url IS NOT NULL
        AND btrim(source_url) <> ''
      ORDER BY vendor_id, distributor_id, source_id`,
  );
  return rows.map((row) => ({
    sourceId: Number(row.source_id),
    sourceUrl: String(row.source_url).trim(),
    vendorId: Number(row.vendor_id),
    distributorId: Number(row.distributor_id),
  }));
}

/**
 * The vendor's catalog devices as a SKU index for normalizeListing() (NWP-PRICE-003).
 * Throws (from buildSkuIndex) if two of the vendor's devices normalize to the same SKU.
 *
 * @param {{ query: Function }} client
 * @param {number} vendorId
 * @returns {Promise<Map<string, number>>}  normalized SKU -> device_id (empty when the vendor has no devices)
 */
async function loadVendorSkuIndex(client, vendorId) {
  const { rows } = await client.query(
    `SELECT device_id, sku
       FROM device
      WHERE vendor_id = $1
        AND sku IS NOT NULL
        AND btrim(sku) <> ''
      ORDER BY device_id`,
    [vendorId],
  );
  return buildSkuIndex(rows.map((row) => ({ deviceId: Number(row.device_id), sku: row.sku })));
}

module.exports = {
  listActiveSources,
  loadVendorSkuIndex,
};
