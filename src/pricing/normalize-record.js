'use strict';

// NWP-PRICE-003: turns the products extracted from one distributor listing page into normalized pricing
// records, or rejects them.
//
// Pricing sources are listing pages (one URL per vendor and distributor, many products per page). Each
// extracted product is matched to a catalog device of the source's vendor by normalized SKU:
//
//   input:  products Firecrawl extracted from the page ([{ sku, price, ... }], NWP-PRICE-002),
//           the pricing source ({ sourceId, vendorId, distributorId }, NWP-PRICE-001),
//           the vendor's SKU index (buildSkuIndex), and the retrieval time.
//   output: records ready for upsertSynchronizedPrice() (NWP-PRICE-002) and rejections with a reason.
//
// Reasons are NWP-PRICE-004 SYNC_STATUS values. `no_sku_match` means the product is not in this vendor's
// catalog; on a listing page that is normal (stores list many models we do not track), so the caller skips
// it rather than logging a failure. Nothing is written to the database here.
//
// Prices are VAT-inclusive as listed (see price-formats.js).

const { parsePrice } = require('./price-formats');

const NORMALIZE_REJECT_REASONS = Object.freeze({
  MISSING_FIELD: 'missing_field',
  INVALID_PRICE: 'invalid_price',
  NO_SKU_MATCH: 'no_sku_match',
});

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const MAX_DETAIL_VALUE_LENGTH = 80;

/**
 * @typedef {Object} PricingSourceRef
 * @property {number} sourceId       pricing_source.source_id
 * @property {number} vendorId       pricing_source.vendor_id
 * @property {number} distributorId  pricing_source.distributor_id
 */

/**
 * @typedef {Object} NormalizedPriceRecord
 * @property {number} deviceId
 * @property {number} distributorId
 * @property {number} sourceId
 * @property {string} price          two-decimal string for pricing.price (DECIMAL), e.g. "1234.00"
 * @property {number} priceCentavos  same amount as an integer, for median arithmetic (NWP-PRICE-008)
 * @property {Date}   retrievedAt    becomes pricing.last_updated
 * @property {string} pageSku        SKU as it appeared on the page (for logs)
 */

/**
 * @typedef {Object} Rejection
 * @property {string} reason   one of NORMALIZE_REJECT_REASONS
 * @property {string} detail   message for update_log.error
 * @property {number} [deviceId] set when the product matched a catalog device
 * @property {*}      [pageSku]
 */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim().length === 0);
}

// Short, quoted copy of a scraped value for update_log.error.
function show(value) {
  const text = JSON.stringify(value === undefined ? null : value);
  return text.length > MAX_DETAIL_VALUE_LENGTH ? `${text.slice(0, MAX_DETAIL_VALUE_LENGTH)}…` : text;
}

/**
 * Normalizes a SKU for comparison: NFKC, strip zero-width characters, trim, uppercase, collapse
 * internal whitespace to one space. Hyphens and other punctuation are kept as they are.
 *
 * @param {*} raw
 * @returns {string|null} null when there is no usable SKU
 */
function normalizeSku(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const sku = String(raw)
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return sku.length > 0 ? sku : null;
}

/**
 * Builds the lookup from normalized SKU to device_id for ONE vendor's catalog.
 * Throws when two devices of the vendor normalize to the same SKU (the match would be ambiguous).
 *
 * @param {Array<{ deviceId: number, sku: string }>} devices
 * @returns {Map<string, number>}
 */
function buildSkuIndex(devices) {
  if (!Array.isArray(devices)) throw new TypeError('buildSkuIndex: devices must be an array.');
  const index = new Map();
  devices.forEach((device, i) => {
    if (!isPlainObject(device) || !isPositiveInteger(device.deviceId)) {
      throw new TypeError(`buildSkuIndex: devices[${i}].deviceId must be a positive integer.`);
    }
    const key = normalizeSku(device.sku);
    if (key === null) throw new TypeError(`buildSkuIndex: devices[${i}].sku must be a non-empty string.`);
    if (index.has(key) && index.get(key) !== device.deviceId) {
      throw new Error(`buildSkuIndex: devices ${index.get(key)} and ${device.deviceId} both normalize to SKU "${key}".`);
    }
    index.set(key, device.deviceId);
  });
  return index;
}

function toDate(retrievedAt) {
  const date = retrievedAt instanceof Date ? new Date(retrievedAt.getTime()) : new Date(retrievedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function assertInputs(source, skuIndex, retrievedAt) {
  if (!isPlainObject(source)) throw new TypeError('normalize: source must be an object.');
  ['sourceId', 'vendorId', 'distributorId'].forEach((key) => {
    if (!isPositiveInteger(source[key])) {
      throw new TypeError(`normalize: source.${key} must be a positive integer.`);
    }
  });
  if (!(skuIndex instanceof Map)) throw new TypeError('normalize: skuIndex must be a Map from buildSkuIndex().');
  const date = toDate(retrievedAt);
  if (date === null) throw new TypeError('normalize: retrievedAt must be a valid Date or date string.');
  return date;
}

function reject(reason, detail, extra = {}) {
  return { ok: false, reason, detail, ...extra };
}

function normalizeOne(raw, source, skuIndex, retrievedDate) {
  const extracted = isPlainObject(raw) ? raw : {};

  if (isBlank(extracted.sku)) {
    return reject(NORMALIZE_REJECT_REASONS.MISSING_FIELD, 'No SKU was extracted for this product.', { pageSku: null });
  }

  const deviceId = skuIndex.get(normalizeSku(extracted.sku));
  if (deviceId === undefined) {
    return reject(
      NORMALIZE_REJECT_REASONS.NO_SKU_MATCH,
      `SKU ${show(extracted.sku)} is not in this vendor's catalog.`,
      { pageSku: extracted.sku },
    );
  }

  if (isBlank(extracted.price)) {
    return reject(NORMALIZE_REJECT_REASONS.MISSING_FIELD, `No price was extracted for ${show(extracted.sku)}.`, {
      deviceId, pageSku: extracted.sku,
    });
  }

  const parsed = parsePrice(extracted.price);
  if (!parsed.ok) {
    return reject(NORMALIZE_REJECT_REASONS.INVALID_PRICE, `${parsed.detail} Raw value: ${show(extracted.price)}.`, {
      deviceId, pageSku: extracted.sku,
    });
  }

  return {
    ok: true,
    record: {
      deviceId,
      distributorId: source.distributorId,
      sourceId: source.sourceId,
      price: parsed.decimal,
      priceCentavos: parsed.centavos,
      retrievedAt: retrievedDate,
      pageSku: extracted.sku,
    },
  };
}

/**
 * Normalizes one extracted product.
 *
 * Checks run in this order: missing SKU (missing_field) → not in the vendor's catalog (no_sku_match)
 * → missing price (missing_field) → price not a single positive PHP amount (invalid_price).
 *
 * Throws TypeError only for programmer errors (bad source, skuIndex or retrievedAt); scraped data never throws.
 *
 * @param {{ sku?: *, price?: * }} raw
 * @param {PricingSourceRef} source
 * @param {Map<string, number>} skuIndex
 * @param {Date|string} retrievedAt
 * @returns {{ ok: true, record: NormalizedPriceRecord } | ({ ok: false } & Rejection)}
 */
function normalizeRecord(raw, source, skuIndex, retrievedAt) {
  const retrievedDate = assertInputs(source, skuIndex, retrievedAt);
  return normalizeOne(raw, source, skuIndex, retrievedDate);
}

/**
 * Normalizes every product extracted from one listing page.
 *
 * A device that appears more than once on the page:
 *   - with the same price: kept once;
 *   - with different prices: rejected (invalid_price). The page does not say which price applies,
 *     and the normalizer never picks one.
 *
 * @param {Array<{ sku?: *, price?: * }>} products
 * @param {PricingSourceRef} source
 * @param {Map<string, number>} skuIndex
 * @param {Date|string} retrievedAt
 * @returns {{ records: NormalizedPriceRecord[], rejected: Rejection[], unmatched: number }}
 *   `rejected` holds rejections for products that matched a device (or had no SKU at all);
 *   products not in the catalog are only counted in `unmatched`.
 */
function normalizeListing(products, source, skuIndex, retrievedAt) {
  const retrievedDate = assertInputs(source, skuIndex, retrievedAt);
  const list = Array.isArray(products) ? products : [];

  const byDevice = new Map();   // deviceId -> { record, prices: Set<number> }
  const rejected = [];
  let unmatched = 0;

  list.forEach((raw) => {
    const result = normalizeOne(raw, source, skuIndex, retrievedDate);
    if (result.ok) {
      const entry = byDevice.get(result.record.deviceId);
      if (entry) entry.prices.add(result.record.priceCentavos);
      else byDevice.set(result.record.deviceId, { record: result.record, prices: new Set([result.record.priceCentavos]) });
      return;
    }
    if (result.reason === NORMALIZE_REJECT_REASONS.NO_SKU_MATCH) {
      unmatched += 1;
      return;
    }
    rejected.push({ reason: result.reason, detail: result.detail, deviceId: result.deviceId, pageSku: result.pageSku });
  });

  const records = [];
  byDevice.forEach(({ record, prices }, deviceId) => {
    if (prices.size === 1) {
      records.push(record);
      return;
    }
    const listed = [...prices].sort((a, b) => a - b).map((c) => (c / 100).toFixed(2)).join(', ');
    rejected.push({
      reason: NORMALIZE_REJECT_REASONS.INVALID_PRICE,
      detail: `${show(record.pageSku)} is listed more than once with different prices (${listed}); none was used.`,
      deviceId,
      pageSku: record.pageSku,
    });
  });

  return { records, rejected, unmatched };
}

module.exports = {
  normalizeRecord,
  normalizeListing,
  normalizeSku,
  buildSkuIndex,
  NORMALIZE_REJECT_REASONS,
};
