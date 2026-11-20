'use strict';

// NWP-PRICE-002: stores a synchronized price.
//
// One row per device and distributor (UNIQUE (device_id, distributor_id), NWP-PRICE-009). A scraped price
// inserts the row or replaces it, including a manual row (source_id NULL): the synchronized price wins
// and source_id records the listing page it came from. pricing_id is never passed; it has an identity
// default since NWP-PRICE-009.
//
// Staleness and failure counters are not touched here. The caller runs markSyncSuccess() (NWP-PRICE-005)
// in the same transaction.

/**
 * @param {{ query: Function }} client  a client inside the caller's transaction
 * @param {{ deviceId: number, distributorId: number, sourceId: number, price: string, retrievedAt: Date }} record
 *   a record from normalizeListing() (NWP-PRICE-003); `price` is the two-decimal string
 * @returns {Promise<{ pricingId: number, inserted: boolean }>}
 */
async function upsertSynchronizedPrice(client, record) {
  const { deviceId, distributorId, sourceId, price, retrievedAt } = record || {};
  if (!Number.isInteger(deviceId) || !Number.isInteger(distributorId) || !Number.isInteger(sourceId)) {
    throw new TypeError('upsertSynchronizedPrice: deviceId, distributorId and sourceId must be integers.');
  }
  if (typeof price !== 'string' || !/^\d+\.\d{2}$/.test(price)) {
    throw new TypeError('upsertSynchronizedPrice: price must be a two-decimal string from normalizeListing().');
  }
  if (!(retrievedAt instanceof Date) || Number.isNaN(retrievedAt.getTime())) {
    throw new TypeError('upsertSynchronizedPrice: retrievedAt must be a valid Date.');
  }

  const { rows } = await client.query(
    `INSERT INTO pricing (device_id, distributor_id, source_id, price, last_updated)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (device_id, distributor_id) DO UPDATE
        SET price        = EXCLUDED.price,
            source_id    = EXCLUDED.source_id,
            last_updated = EXCLUDED.last_updated
     RETURNING pricing_id, (xmax = 0) AS inserted`,
    [deviceId, distributorId, sourceId, price, retrievedAt],
  );
  return { pricingId: Number(rows[0].pricing_id), inserted: rows[0].inserted === true };
}

module.exports = {
  upsertSynchronizedPrice,
};
