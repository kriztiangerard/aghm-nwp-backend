'use strict';

// NWP-PRICE-003: turns one extracted page result into a normalized pricing record, or rejects it.
//
// Input:  the JSON Firecrawl extracted from one product page ({ sku, price }, NWP-PRICE-002),
//         the active pricing source it came from (NWP-PRICE-001 / 009), and the retrieval time.
// Output: { ok: true, record } ready for upsertSynchronizedPrice() (NWP-PRICE-002),
//         or { ok: false, reason, detail }, where reason is one of NORMALIZE_REJECT_REASONS.
//
// The reasons are NWP-PRICE-004 SYNC_STATUS values and are written to update_log.status; detail goes
// to update_log.error. Nothing is written to the database here.
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
 * @property {number} deviceId       pricing_source.device_id (added in NWP-PRICE-009)
 * @property {number} distributorId  pricing_source.distributor_id
 * @property {string} deviceSku      device.sku of the device this source is configured for
 */

/**
 * @typedef {Object} NormalizedPriceRecord
 * @property {number} deviceId
 * @property {number} distributorId
 * @property {number} sourceId
 * @property {string} price          two-decimal string for pricing.price (DECIMAL), e.g. "1234.00"
 * @property {number} priceCentavos  same amount as an integer, for median arithmetic (NWP-PRICE-008)
 * @property {Date}   retrievedAt    becomes pricing.last_updated
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

function toDate(retrievedAt) {
  const date = retrievedAt instanceof Date ? new Date(retrievedAt.getTime()) : new Date(retrievedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function assertSource(source) {
  if (!isPlainObject(source)) throw new TypeError('normalizeRecord: source must be an object.');
  ['sourceId', 'deviceId', 'distributorId'].forEach((key) => {
    if (!isPositiveInteger(source[key])) {
      throw new TypeError(`normalizeRecord: source.${key} must be a positive integer.`);
    }
  });
  if (normalizeSku(source.deviceSku) === null) {
    throw new TypeError('normalizeRecord: source.deviceSku must be a non-empty string.');
  }
}

function rejectRecord(reason, detail) {
  return { ok: false, reason, detail };
}

/**
 * Normalizes one extracted page result.
 *
 * Checks run in this order, so each record gets the most fundamental reason:
 *   1. missing_field: no SKU or no price was extracted
 *   2. no_sku_match:  the page is for a different product than the source's device
 *   3. invalid_price: the price is not a single, positive PHP amount
 *
 * Throws TypeError only for programmer errors (bad source or retrievedAt); scraped data never throws.
 *
 * @param {{ sku?: *, price?: * }} raw   JSON extracted from the page
 * @param {PricingSourceRef} source
 * @param {Date|string} retrievedAt
 * @returns {{ ok: true, record: NormalizedPriceRecord }
 *         | { ok: false, reason: string, detail: string }}
 */
function normalizeRecord(raw, source, retrievedAt) {
  assertSource(source);
  const retrievedDate = toDate(retrievedAt);
  if (retrievedDate === null) {
    throw new TypeError('normalizeRecord: retrievedAt must be a valid Date or date string.');
  }

  const extracted = isPlainObject(raw) ? raw : {};

  if (isBlank(extracted.sku)) {
    return rejectRecord(NORMALIZE_REJECT_REASONS.MISSING_FIELD, 'No SKU was extracted from the page.');
  }
  if (isBlank(extracted.price)) {
    return rejectRecord(NORMALIZE_REJECT_REASONS.MISSING_FIELD, 'No price was extracted from the page.');
  }

  const pageSku = normalizeSku(extracted.sku);
  const expectedSku = normalizeSku(source.deviceSku);
  if (pageSku !== expectedSku) {
    return rejectRecord(
      NORMALIZE_REJECT_REASONS.NO_SKU_MATCH,
      `Page SKU ${show(extracted.sku)} does not match the configured device SKU ${show(source.deviceSku)}.`,
    );
  }

  const parsed = parsePrice(extracted.price);
  if (!parsed.ok) {
    return rejectRecord(NORMALIZE_REJECT_REASONS.INVALID_PRICE, `${parsed.detail} Raw value: ${show(extracted.price)}.`);
  }

  return {
    ok: true,
    record: {
      deviceId: source.deviceId,
      distributorId: source.distributorId,
      sourceId: source.sourceId,
      price: parsed.decimal,
      priceCentavos: parsed.centavos,
      retrievedAt: retrievedDate,
    },
  };
}

module.exports = {
  normalizeRecord,
  normalizeSku,
  NORMALIZE_REJECT_REASONS,
};
