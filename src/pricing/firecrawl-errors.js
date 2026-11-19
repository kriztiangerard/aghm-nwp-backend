'use strict';

// NWP-PRICE-007: the single list of error types the Firecrawl wrapper can return.
// NWP-PRICE-004 maps these one-to-one onto update_log.status values (SYNC_STATUS); keep the two in step.

const FIRECRAWL_ERROR_TYPES = Object.freeze({
  TIMEOUT: 'timeout',               // page or request took too long (client abort, Firecrawl 408/504)
  RATE_LIMITED: 'rate_limited',     // Firecrawl 429 (our plan's request rate)
  BLOCKED: 'blocked',               // target refused access (CAPTCHA/anti-bot/login wall) or Firecrawl declined the site
  INVALID_URL: 'invalid_url',       // malformed URL, or the product page no longer exists (target 404/410)
  HTTP_ERROR: 'http_error',         // any other non-success response from Firecrawl or the target
  EMPTY_CONTENT: 'empty_content',   // success, but no usable JSON was extracted
  AUTH_ERROR: 'auth_error',         // API key missing, unreadable, or rejected (Firecrawl 401)
  QUOTA_EXCEEDED: 'quota_exceeded', // plan credits exhausted (Firecrawl 402)
  NETWORK_ERROR: 'network_error',   // Firecrawl unreachable (DNS/TLS/connection, e.g. NAT instance not running)
});

const ERROR_TYPE_VALUES = new Set(Object.values(FIRECRAWL_ERROR_TYPES));

function isFirecrawlErrorType(value) {
  return ERROR_TYPE_VALUES.has(value);
}

module.exports = {
  FIRECRAWL_ERROR_TYPES,
  isFirecrawlErrorType,
};
