'use strict';

// NWP-PRICE-002 / 004: collects prices for one batch, i.e. every active listing page of ONE vendor and ONE
// distributor (the `process` action of the Price updater).
//
//   1. Load the vendor's catalog as a SKU index. A vendor with no devices is skipped without scraping,
//      so no Firecrawl credits are spent on it.
//   2. Scrape every page with Firecrawl's JSON extraction (LISTING_SCHEMA), at most `concurrency` at once.
//      Each page is isolated (004): a failure is recorded for that page and the others continue.
//        - `timeout` and `rate_limited` are retried once after a short backoff; nothing else is retried.
//        - An account-level error (auth_error, quota_exceeded, network_error) stops the batch: pages not
//          yet started are skipped and the summary carries `stoppedBy`, so the workflow stops (NWP-PRICE-011).
//        - No products array is `invalid_response`; an empty list is `empty_content`.
//   3. Normalize each page (normalizeListing, NWP-PRICE-003).
//   4. Combine the pages: a device found on two pages at different prices is stored from neither
//      (the same rule normalizeListing applies within one page).
//   5. Store each found device in its own transaction: upsertSynchronizedPrice() then markSyncSuccess() (005).
//      A database error rolls back only that device and is reported as `db_error` (004).
//   6. Return a summary; recordBatchOutcome() (outcome.js, 004) turns it into one update_log row per device.
//
// One structured log line is written per page, so failures of pages with no attributed devices are visible.
// The scraper never follows links: a store that spreads a vendor over several pages has one source per page URL.

const { scrapeProductPage } = require('./firecrawl-client');
const { LISTING_SCHEMA, readProducts } = require('./extraction');
const { normalizeListing, NORMALIZE_REJECT_REASONS } = require('./normalize-record');
const { loadVendorSkuIndex } = require('./sources');
const { upsertSynchronizedPrice } = require('./price-store');
const { markSyncSuccess: markSyncSuccessInDb } = require('./pricing-state');
const { SYNC_STATUS, RETRYABLE, ACCOUNT_LEVEL, fromFirecrawlError } = require('./sync-status');
const db = require('./db');

const PAGE_STATUS = Object.freeze({
  SUCCESS: SYNC_STATUS.SUCCESS, // scraped and normalized (failures use SYNC_STATUS values)
  SKIPPED: 'skipped',           // not scraped: no catalog devices, or the batch stopped first
});

const DEFAULT_RETRY_DELAY_MS = 2000;   // timeout: a short pause before the one retry
const DEFAULT_RATE_LIMIT_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 30000;      // never wait longer than this, whatever Retry-After says

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

/** Backoff before the one retry: Retry-After when given (capped), otherwise a fixed short pause. */
function retryDelayMs(result) {
  if (result.errorType === SYNC_STATUS.RATE_LIMITED) {
    return Number.isFinite(result.retryAfterSeconds)
      ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, result.retryAfterSeconds * 1000))
      : DEFAULT_RATE_LIMIT_DELAY_MS;
  }
  return DEFAULT_RETRY_DELAY_MS;
}

/** One scrape plus at most one retry for timeout / rate_limited. Never throws for scrape failures. */
async function scrapeWithRetry(url, ctx) {
  let result = await ctx.scrape(url, { schema: LISTING_SCHEMA });
  let attempts = 1;
  if (result && result.ok !== true && RETRYABLE.has(result.errorType)) {
    await ctx.sleep(retryDelayMs(result));
    result = await ctx.scrape(url, { schema: LISTING_SCHEMA });
    attempts = 2;
  }
  return { result, attempts };
}

function failedPage(sourceId, status, message, extra = {}) {
  return { page: { sourceId, status, productCount: 0, ...extra, message }, listing: null };
}

async function processPage(source, ctx) {
  const { sourceId } = source;
  if (ctx.stoppedBy) {
    return failedPage(sourceId, PAGE_STATUS.SKIPPED, `Not scraped: the batch stopped after ${ctx.stoppedBy.status}.`);
  }

  try {
    const retrievedAt = ctx.now();
    const { result, attempts } = await scrapeWithRetry(source.sourceUrl, ctx);
    const base = { attempts };
    if (result && Number.isFinite(result.creditsUsed)) base.creditsUsed = result.creditsUsed;

    if (!result || result.ok !== true) {
      const status = fromFirecrawlError(result && result.errorType);
      const message = result && result.message ? result.message : 'Scrape failed without details.';
      if (ACCOUNT_LEVEL.has(status) && !ctx.stoppedBy) ctx.stoppedBy = { status, sourceId, message };
      return failedPage(sourceId, status, message, base);
    }

    const products = readProducts(result.json);
    if (products === null) {
      return failedPage(sourceId, SYNC_STATUS.INVALID_RESPONSE, 'The extracted JSON has no products array.', base);
    }
    if (products.length === 0) {
      return failedPage(sourceId, SYNC_STATUS.EMPTY_CONTENT, 'The page listed no products.', base);
    }

    const listing = normalizeListing(
      products,
      { sourceId, vendorId: ctx.vendorId, distributorId: ctx.distributorId },
      ctx.skuIndex,
      retrievedAt,
    );
    const deviceRejections = listing.rejected.filter((r) => Number.isInteger(r.deviceId));
    return {
      page: {
        sourceId,
        status: PAGE_STATUS.SUCCESS,
        productCount: products.length,
        matched: listing.records.length + deviceRejections.length,
        unmatched: listing.unmatched,
        rejectedWithoutDevice: listing.rejected.length - deviceRejections.length,
        ...base,
      },
      listing,
    };
  } catch (error) {
    // A bug or an unexpected exception: isolate it to this page.
    return failedPage(sourceId, SYNC_STATUS.UNEXPECTED_ERROR,
      `Unexpected error while processing the page: ${error && error.message ? error.message : String(error)}`);
  }
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

function logPage(logger, runAt, page) {
  logger.log(JSON.stringify({
    source: 'price-updater', event: 'page', runAt,
    sourceId: page.sourceId, status: page.status, productCount: page.productCount,
    matched: page.matched !== undefined ? page.matched : 0,
    attempts: page.attempts !== undefined ? page.attempts : 0,
  }));
}

/**
 * The `process` action's collection step.
 *
 * @param {{ runAt: string, vendorId: number, distributorId: number,
 *           sources: Array<{ sourceId: number, sourceUrl: string }> }} input
 * @param {Object} [deps]  injected in tests; defaults use Firecrawl and the database
 * @param {number}   [deps.concurrency]      pages scraped at once (FIRECRAWL_CONCURRENCY)
 * @param {Function} [deps.scrape]           scrapeProductPage(url, options)
 * @param {Function} [deps.loadSkuIndex]     async (vendorId) => Map
 * @param {Function} [deps.withTransaction]  db.withTransaction
 * @param {Function} [deps.upsertPrice]      upsertSynchronizedPrice(client, record)
 * @param {Function} [deps.markSyncSuccess]  async (client, { deviceId, distributorId }); default pricing-state.js
 * @param {Function} [deps.now]              () => Date, the retrieval time of each page
 * @param {Function} [deps.sleep]            async (ms), the retry backoff
 * @param {{ log: Function }} [deps.logger]  default: console
 * @returns {Promise<BatchSummary>}
 */
async function processSourceBatch(input, {
  concurrency = 2,
  scrape = scrapeProductPage,
  loadSkuIndex = async (vendorId) => loadVendorSkuIndex(await db.getPool(), vendorId),
  withTransaction = db.withTransaction,
  upsertPrice = upsertSynchronizedPrice,
  markSyncSuccess = markSyncSuccessInDb,   // clears is_stale (NWP-PRICE-005)
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
} = {}) {
  const { runAt, vendorId, distributorId, sources } = validateBatch(input);
  const summary = {
    runAt, vendorId, distributorId,
    pages: [], found: [], rejected: [], dbErrors: [], stored: { inserted: 0, updated: 0 }, stoppedBy: null,
  };

  const skuIndex = await loadSkuIndex(vendorId);
  if (skuIndex.size === 0) {
    summary.pages = sources.map((s) => ({
      sourceId: s.sourceId, status: PAGE_STATUS.SKIPPED, productCount: 0,
      message: 'The vendor has no catalog devices, so the page was not scraped.',
    }));
    summary.pages.forEach((page) => logPage(logger, runAt, page));
    return summary;
  }

  const ctx = { scrape, sleep, now, vendorId, distributorId, skuIndex, stoppedBy: null };
  const results = await mapWithConcurrency(sources, concurrency, (source) => processPage(source, ctx));
  summary.pages = results.map((r) => r.page);
  summary.stoppedBy = ctx.stoppedBy;
  summary.pages.forEach((page) => logPage(logger, runAt, page));

  const { toStore, rejected } = combinePages(results.map((r) => r.listing));
  summary.rejected = rejected;

  for (const record of toStore) {
    // One transaction per device, so one device's failure never rolls back another's.
    try {
      // eslint-disable-next-line no-await-in-loop
      const { inserted } = await withTransaction(async (client) => {
        const stored = await upsertPrice(client, record);
        await markSyncSuccess(client, { deviceId: record.deviceId, distributorId: record.distributorId });
        return stored;
      });
      summary.found.push(record.deviceId);
      if (inserted) summary.stored.inserted += 1;
      else summary.stored.updated += 1;
    } catch (error) {
      summary.dbErrors.push({
        deviceId: record.deviceId,
        detail: `Storing the price failed: ${error && error.message ? error.message : String(error)}`,
      });
    }
  }

  return summary;
}

/**
 * @typedef {Object} BatchSummary
 * @property {string} runAt
 * @property {number} vendorId
 * @property {number} distributorId
 * @property {Array<{ sourceId: number, status: string, productCount: number, matched?: number,
 *   unmatched?: number, rejectedWithoutDevice?: number, attempts?: number, message?: string,
 *   creditsUsed?: number }>} pages
 * @property {number[]} found      devices stored with a new price, ascending
 * @property {Array<{ deviceId: number, reason: string, detail: string }>} rejected  found but not usable
 * @property {Array<{ deviceId: number, detail: string }>} dbErrors  found, but storing failed
 * @property {{ inserted: number, updated: number }} stored
 * @property {{ status: string, sourceId: number, message: string } | null} stoppedBy  account-level stop
 */

module.exports = {
  processSourceBatch,
  combinePages,
  mapWithConcurrency,
  retryDelayMs,
  InvalidBatchError,
  PAGE_STATUS,
  MAX_RETRY_DELAY_MS,
};