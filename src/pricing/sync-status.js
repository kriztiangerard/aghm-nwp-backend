'use strict';

// NWP-PRICE-004: the single list of sync outcomes, used for pages, devices and update_log.status.
//
// Firecrawl error types (NWP-PRICE-007) and normalizer rejection reasons (NWP-PRICE-003) map onto these
// one-to-one, by the same string, so a status always means the same thing wherever it appears.

const { FIRECRAWL_ERROR_TYPES: E } = require('./firecrawl-errors');
const { NORMALIZE_REJECT_REASONS: R } = require('./normalize-record');

const SYNC_STATUS = Object.freeze({
  SUCCESS: 'success',                 // price found and stored
  // Page retrieval (FIRECRAWL_ERROR_TYPES)
  TIMEOUT: E.TIMEOUT,
  RATE_LIMITED: E.RATE_LIMITED,
  BLOCKED: E.BLOCKED,
  INVALID_URL: E.INVALID_URL,
  HTTP_ERROR: E.HTTP_ERROR,
  EMPTY_CONTENT: E.EMPTY_CONTENT,     // the page listed no products
  AUTH_ERROR: E.AUTH_ERROR,
  QUOTA_EXCEEDED: E.QUOTA_EXCEEDED,
  NETWORK_ERROR: E.NETWORK_ERROR,
  INVALID_RESPONSE: 'invalid_response', // the extracted JSON had no products array
  // Device data (NORMALIZE_REJECT_REASONS)
  MISSING_FIELD: R.MISSING_FIELD,
  INVALID_PRICE: R.INVALID_PRICE,
  // Attribution
  NOT_LISTED: 'not_listed',           // last priced from a page that succeeded, but no longer listed in the batch
  DB_ERROR: 'db_error',               // storing this device failed; only its transaction was rolled back
  UNEXPECTED_ERROR: 'unexpected_error',
});

const VALUES = new Set(Object.values(SYNC_STATUS));

/** Retried once with a short backoff; everything else is never retried (`blocked` above all). */
const RETRYABLE = new Set([SYNC_STATUS.TIMEOUT, SYNC_STATUS.RATE_LIMITED]);

/**
 * Not a distributor's fault: the batch stops, the workflow stops (NWP-PRICE-011), and no price is marked stale.
 */
const ACCOUNT_LEVEL = new Set([SYNC_STATUS.AUTH_ERROR, SYNC_STATUS.QUOTA_EXCEEDED, SYNC_STATUS.NETWORK_ERROR]);

function isSyncStatus(value) {
  return VALUES.has(value);
}

/** Firecrawl error type -> status (same string); anything unknown is unexpected_error. */
function fromFirecrawlError(errorType) {
  return Object.values(E).includes(errorType) ? errorType : SYNC_STATUS.UNEXPECTED_ERROR;
}

/** Normalizer rejection reason -> status (same string); anything unknown is unexpected_error. */
function fromRejectReason(reason) {
  return reason === R.MISSING_FIELD || reason === R.INVALID_PRICE ? reason : SYNC_STATUS.UNEXPECTED_ERROR;
}

module.exports = {
  SYNC_STATUS,
  RETRYABLE,
  ACCOUNT_LEVEL,
  isSyncStatus,
  fromFirecrawlError,
  fromRejectReason,
};