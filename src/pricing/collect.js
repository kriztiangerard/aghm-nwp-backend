'use strict';

// NWP-PRICE-002: collects prices for one batch, i.e. every active listing page of ONE vendor and ONE
// distributor (the `process` action of the Price updater).
//
//   1. Load the vendor's catalog as a SKU index. A vendor with no devices is skipped without scraping,
//      so no Firecrawl credits are spent on it.
//   2. Scrape every page with Firecrawl's JSON extraction (LISTING_SCHEMA), at most `concurrency` at once.
//      A page with no product list is `empty_content`.
//   3. Normalize each page (normalizeListing, NWP-PRICE-003).
//   4. Combine the pages: a device found on two pages at different prices is stored from neither
//      (the same rule normalizeListing applies within one page).
//   5. Store each found device in its own transaction: upsertSynchronizedPrice() then markSyncSuccess().
//   6. Return a summary for NWP-PRICE-004 (outcome per device) and the finalize step (NWP-PRICE-011).
//
// Not here, by design: retries, stopping on account-level errors, update_log rows and marking prices stale
// are NWP-PRICE-004/005. A failed page simply appears in `pages` with its error type. The scraper never
// follows links: a store that spreads a vendor over several pages has one source row per page URL.

const { scrapeProductPage } = require('./firecrawl-client');
const { FIRECRAWL_ERROR_TYPES: E } = require('./firecrawl-errors');
const { LISTING_SCHEMA, readProducts } = require('./extraction');
const { normalizeListing, NORMALIZE_REJECT_REASONS } = require('./normalize-record');
const { loadVendorSkuIndex } = require('./sources');
const { upsertSynchronizedPrice } = require('./price-store');
const db = require('./db');

const PAGE_STATUS = Object.freeze({
  SUCCESS: 'success',   // scraped and normalized (failures use FIRECRAWL_ERROR_TYPES values)
  SKIPPED: 'skipped',   // not scraped: the vendor has no catalog devices
});

class InvalidBatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidBatchError';
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validateBatch(input) {
  if (input === null || typeof input !== 'object') throw new InvalidBatchError('Batch must be an object.');
  const { runAt, vendorId, distributorId, sources } = input;
  if (typeof runAt !== 'string' || Number.isNaN(new Date(runAt).getTime())) {
    throw new InvalidBatchError('runAt must be an ISO date string (the run\'s shared start time).');
  }
  if (!isPositiveInteger(vendorId) || !isPositiveInteger(distributorId)) {
    throw new InvalidBatchError('vendorId and distributorId must be positive integers.');
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new InvalidBatchError('sources must be a non-empty array.');
  }
  const seen = new Set();
  sources.forEach((source, i) => {
    if (!source || !isPositiveInteger(source.sourceId) || typeof source.sourceUrl !== 'string' || !source.sourceUrl.trim()) {
      throw new InvalidBatchError(`sources[${i}] needs a positive integer sourceId and a sourceUrl.`);
    }
    if (seen.has(source.sourceId)) throw new InvalidBatchError(`sources[${i}]: sourceId ${source.sourceId} is listed twice.`);
    seen.add(source.sourceId);
  });
  return { runAt, vendorId, distributorId, sources };
}

/** Runs `worker` over `items` with at most `limit` in flight; results keep the input order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

async function scrapePage(source, ctx) {
  const retrievedAt = ctx.now();
  const result = await ctx.scrape(source.sourceUrl, { schema: LISTING_SCHEMA });
  const base = { sourceId: source.sourceId };
  if (result && Number.isFinite(result.creditsUsed)) base.creditsUsed = result.creditsUsed;

  if (!result || result.ok !== true) {
    return {
      page: { ...base, status: result && result.errorType ? result.errorType : E.HTTP_ERROR, productCount: 0,
        message: result && result.message ? result.message : 'Scrape failed without details.' },
      listing: null,
    };
  }

  const products = readProducts(result.json);
  if (products === null || products.length === 0) {
    return {
      page: { ...base, status: E.EMPTY_CONTENT, productCount: 0,
        message: products === null ? 'The extracted JSON has no products array.' : 'The page listed no products.' },
      listing: null,
    };
  }

  const listing = normalizeListing(
    products,
    { sourceId: source.sourceId, vendorId: ctx.vendorId, distributorId: ctx.distributorId },
    ctx.skuIndex,
    retrievedAt,
  );
  const deviceRejections = listing.rejected.filter((r) => Number.isInteger(r.deviceId));
  return {
    page: {
      ...base,
      status: PAGE_STATUS.SUCCESS,
      productCount: products.length,
      matched: listing.records.length + deviceRejections.length,
      unmatched: listing.unmatched,
      rejectedWithoutDevice: listing.rejected.length - deviceRejections.length,
    },
    listing,
  };
}

/**
 * Combines the pages' normalized results into one decision per device (pages are in batch order).
 * @returns {{ toStore: object[], rejected: Array<{ deviceId: number, reason: string, detail: string }> }}
 */
function combinePages(listings) {
  const byDevice = new Map(); // deviceId -> { records: [], rejection: null }
  const entry = (deviceId) => {
    if (!byDevice.has(deviceId)) byDevice.set(deviceId, { records: [], rejection: null });
    return byDevice.get(deviceId);
  };

  listings.forEach((listing) => {
    if (!listing) return;
    listing.records.forEach((record) => entry(record.deviceId).records.push(record));
    listing.rejected.forEach((rejection) => {
      if (!Number.isInteger(rejection.deviceId)) return;
      const e = entry(rejection.deviceId);
      if (!e.rejection) e.rejection = { reason: rejection.reason, detail: rejection.detail };
    });
  });

  const toStore = [];
  const rejected = [];
  byDevice.forEach(({ records, rejection }, deviceId) => {
    if (records.length === 0) {
      rejected.push({ deviceId, ...rejection });
      return;
    }
    const prices = new Set(records.map((r) => r.priceCentavos));
    if (prices.size === 1) {
      toStore.push(records[0]);   // the first page that listed it
      return;
    }
    const listed = [...prices].sort((a, b) => a - b).map((c) => (c / 100).toFixed(2)).join(', ');
    const pageIds = [...new Set(records.map((r) => r.sourceId))].join(', ');
    rejected.push({
      deviceId,
      reason: NORMALIZE_REJECT_REASONS.INVALID_PRICE,
      detail: `Listed on pages ${pageIds} of this distributor at different prices (${listed}); none was used.`,
    });
  });

  toStore.sort((a, b) => a.deviceId - b.deviceId);
  rejected.sort((a, b) => a.deviceId - b.deviceId);
  return { toStore, rejected };
}

/**
 * The `process` action.
 *
 * @param {{ runAt: string, vendorId: number, distributorId: number,
 *           sources: Array<{ sourceId: number, sourceUrl: string }> }} input
 * @param {Object} [deps]  injected in tests; defaults use Firecrawl and the database
 * @param {number}   [deps.concurrency]      pages scraped at once (FIRECRAWL_CONCURRENCY)
 * @param {Function} [deps.scrape]           scrapeProductPage(url, options)
 * @param {Function} [deps.loadSkuIndex]     async (vendorId) => Map
 * @param {Function} [deps.withTransaction]  db.withTransaction
 * @param {Function} [deps.upsertPrice]      upsertSynchronizedPrice(client, record)
 * @param {Function} [deps.markSyncSuccess]  async (client, { deviceId, distributorId }); NWP-PRICE-005
 * @param {Function} [deps.now]              () => Date, the retrieval time of each page
 * @returns {Promise<BatchSummary>}
 */
async function processSourceBatch(input, {
  concurrency = 2,
  scrape = scrapeProductPage,
  loadSkuIndex = async (vendorId) => loadVendorSkuIndex(await db.getPool(), vendorId),
  withTransaction = db.withTransaction,
  upsertPrice = upsertSynchronizedPrice,
  // NWP-PRICE-005 provides the real markSyncSuccess (clears is_stale); until then a successful store
  // changes only the price, source and retrieval time.
  markSyncSuccess = async () => {},
  now = () => new Date(),
} = {}) {
  const { runAt, vendorId, distributorId, sources } = validateBatch(input);
  const summary = { runAt, vendorId, distributorId, pages: [], found: [], rejected: [], stored: { inserted: 0, updated: 0 } };

  const skuIndex = await loadSkuIndex(vendorId);
  if (skuIndex.size === 0) {
    summary.pages = sources.map((s) => ({
      sourceId: s.sourceId, status: PAGE_STATUS.SKIPPED, productCount: 0,
      message: 'The vendor has no catalog devices, so the page was not scraped.',
    }));
    return summary;
  }

  const ctx = { scrape, now, vendorId, distributorId, skuIndex };
  const results = await mapWithConcurrency(sources, concurrency, (source) => scrapePage(source, ctx));
  summary.pages = results.map((r) => r.page);

  const { toStore, rejected } = combinePages(results.map((r) => r.listing));
  summary.rejected = rejected;

  for (const record of toStore) {
    // One transaction per device, so one device's write never rolls back another's.
    // eslint-disable-next-line no-await-in-loop
    const { inserted } = await withTransaction(async (client) => {
      const stored = await upsertPrice(client, record);
      await markSyncSuccess(client, { deviceId: record.deviceId, distributorId: record.distributorId });
      return stored;
    });
    summary.found.push(record.deviceId);
    if (inserted) summary.stored.inserted += 1;
    else summary.stored.updated += 1;
  }

  return summary;
}

/**
 * @typedef {Object} BatchSummary
 * @property {string} runAt
 * @property {number} vendorId
 * @property {number} distributorId
 * @property {Array<{ sourceId: number, status: string, productCount: number, matched?: number,
 *   unmatched?: number, rejectedWithoutDevice?: number, message?: string, creditsUsed?: number }>} pages
 * @property {number[]} found      devices stored with a new price, ascending
 * @property {Array<{ deviceId: number, reason: string, detail: string }>} rejected  devices found but not stored
 * @property {{ inserted: number, updated: number }} stored
 */

module.exports = {
  processSourceBatch,
  combinePages,
  mapWithConcurrency,
  InvalidBatchError,
  PAGE_STATUS,
};
