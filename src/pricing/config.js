'use strict';

// NWP-PRICE-010: Price updater settings, read from the Lambda environment (set in lib/aghm-nwp-stack.ts)
// or from .env locally. A malformed value throws, so a bad deployment fails loudly on the first
// invocation instead of running with a guessed setting.
//
//   FIRECRAWL_CONCURRENCY       positive integer, default 2. Pages scraped at once inside one batch
//                               (NWP-PRICE-002). Set it from the Firecrawl plan's concurrent-request limit.
//   PRICE_MEDIAN_INCLUDE_STALE  'true' | 'false', default false. Whether stale synchronized prices join
//                               the median when at least one fresh price exists (NWP-PRICE-008).

const DEFAULTS = Object.freeze({
  firecrawlConcurrency: 2,
  medianIncludeStale: false,
});

function isUnset(raw) {
  return raw === undefined || raw === null || String(raw).trim() === '';
}

function parsePositiveInteger(name, raw, fallback) {
  if (isUnset(raw)) return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text) || Number(text) < 1 || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return Number(text);
}

function parseBoolean(name, raw, fallback) {
  if (isUnset(raw)) return fallback;
  const text = String(raw).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(raw)}.`);
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ firecrawlConcurrency: number, medianIncludeStale: boolean }}
 */
function loadPricingConfig(env = process.env) {
  return Object.freeze({
    firecrawlConcurrency: parsePositiveInteger('FIRECRAWL_CONCURRENCY', env.FIRECRAWL_CONCURRENCY, DEFAULTS.firecrawlConcurrency),
    medianIncludeStale: parseBoolean('PRICE_MEDIAN_INCLUDE_STALE', env.PRICE_MEDIAN_INCLUDE_STALE, DEFAULTS.medianIncludeStale),
  });
}

module.exports = {
  loadPricingConfig,
  DEFAULTS,
};
