'use strict';

// NWP-PRICE-007: thin wrapper around the Firecrawl v2 REST API (POST /v2/scrape).
//
// - Native fetch only (no Firecrawl SDK), so the Lambda zip keeps zero npm dependencies.
// - Uses Firecrawl's JSON format with a caller-supplied schema, so no site-specific parsers are needed.
// - Request failures are returned as typed results; the function never throws for them.
//   It throws a TypeError only for programmer errors (no schema and no prompt).
// - CAPTCHA and anti-bot blocks are reported as `blocked`. The wrapper never sends options meant to
//   solve or get around them, and never retries (retry policy lives in NWP-PRICE-004).

const { FIRECRAWL_ERROR_TYPES: E } = require('./firecrawl-errors');
const { getFirecrawlApiKey } = require('./firecrawl-secret');

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev/v2';
const DEFAULT_PAGE_TIMEOUT_MS = 60000;  // Firecrawl's own default page timeout
const MIN_PAGE_TIMEOUT_MS = 1000;       // Firecrawl minimum
const MAX_PAGE_TIMEOUT_MS = 300000;     // Firecrawl maximum
const DEFAULT_TIMEOUT_MARGIN_MS = 15000; // client waits a little longer than Firecrawl's page timeout
const DEFAULT_COUNTRY = 'PH';           // Philippine distributors; Firecrawl defaults to US otherwise
const MAX_MESSAGE_LENGTH = 500;

// Target-site statuses (data.metadata.statusCode) that mean the site refused us.
const BLOCKED_TARGET_STATUSES = new Set([401, 403, 429, 451]);
// Target-site statuses that mean the configured product page no longer exists.
const MISSING_PAGE_STATUSES = new Set([404, 410]);

/**
 * @typedef {Object} ScrapeOptions
 * @property {Object} [schema]        JSON Schema for Firecrawl's JSON format (required unless prompt is given)
 * @property {string} [prompt]        Extraction prompt for Firecrawl's JSON format
 * @property {number} [pageTimeoutMs] Firecrawl page timeout, 1000 to 300000 ms (default 60000)
 * @property {string} [country]       ISO country code for Firecrawl's location setting (default 'PH')
 */

/**
 * @typedef {Object} ScrapeSuccess
 * @property {true}   ok
 * @property {Object} json             Extracted JSON (shape defined by the schema)
 * @property {number} httpStatus       Firecrawl HTTP status
 * @property {number} [targetStatusCode] Status the distributor site returned to Firecrawl
 * @property {number} [creditsUsed]    Credits Firecrawl reports for the request, when present
 */

/**
 * @typedef {Object} ScrapeFailure
 * @property {false}  ok
 * @property {string} errorType        One of FIRECRAWL_ERROR_TYPES
 * @property {string} message          Human-readable detail (never contains the API key)
 * @property {number} [httpStatus]     Firecrawl HTTP status, when a response was received
 * @property {number} [targetStatusCode] Status the distributor site returned, when known
 * @property {number} [retryAfterSeconds] From Retry-After on 429 responses
 */

/** @typedef {ScrapeSuccess | ScrapeFailure} ScrapeResult */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function clampPageTimeout(value) {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_TIMEOUT_MS;
  return Math.min(MAX_PAGE_TIMEOUT_MS, Math.max(MIN_PAGE_TIMEOUT_MS, Math.round(value)));
}

// True when every top-level value is null, undefined or an empty/whitespace string.
// An LLM extraction over a challenge or error page usually comes back like this.
function hasNoUsableValues(json) {
  const values = Object.values(json);
  if (values.length === 0) return true;
  return values.every((v) => v === null || v === undefined || (typeof v === 'string' && v.trim().length === 0));
}

function parseRetryAfter(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function makeMessageSanitizer(apiKey) {
  return function sanitize(text) {
    let message = typeof text === 'string' ? text : String(text);
    if (apiKey) message = message.split(apiKey).join('[redacted]');
    return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
  };
}

function describeBody(body, fallback) {
  if (!isPlainObject(body)) return fallback;
  const parts = [body.code, body.error].filter((p) => typeof p === 'string' && p.length > 0);
  return parts.length > 0 ? parts.join(': ') : fallback;
}

function failure(errorType, message, extra = {}) {
  const result = { ok: false, errorType, message };
  Object.keys(extra).forEach((key) => {
    if (extra[key] !== undefined) result[key] = extra[key];
  });
  return result;
}

// Maps a non-2xx Firecrawl response to a typed failure.
function mapFirecrawlStatus(status, body, headers, sanitize) {
  const detail = sanitize(describeBody(body, `Firecrawl returned HTTP ${status}.`));
  switch (status) {
    case 401:
      return failure(E.AUTH_ERROR, detail, { httpStatus: status });
    case 402:
      return failure(E.QUOTA_EXCEEDED, detail, { httpStatus: status });
    case 403:
      // Firecrawl declined to scrape the site (policy or terms). Same remedy as a block: human review.
      return failure(E.BLOCKED, detail, { httpStatus: status });
    case 408:
    case 504:
      return failure(E.TIMEOUT, detail, { httpStatus: status });
    case 429:
      return failure(E.RATE_LIMITED, detail, { httpStatus: status, retryAfterSeconds: parseRetryAfter(headers) });
    default:
      return failure(E.HTTP_ERROR, detail, { httpStatus: status });
  }
}

// Maps the distributor site's own status (reported inside a successful Firecrawl response).
function mapTargetStatus(targetStatusCode, metadataError, httpStatus, sanitize) {
  if (!Number.isInteger(targetStatusCode) || targetStatusCode < 400) return null;

  const base = `Distributor site returned HTTP ${targetStatusCode}`;
  const message = sanitize(metadataError ? `${base}: ${metadataError}` : `${base}.`);
  const extra = { httpStatus, targetStatusCode };

  if (BLOCKED_TARGET_STATUSES.has(targetStatusCode)) return failure(E.BLOCKED, message, extra);
  if (MISSING_PAGE_STATUSES.has(targetStatusCode)) return failure(E.INVALID_URL, message, extra);
  return failure(E.HTTP_ERROR, message, extra);
}

function buildRequestBody(url, { schema, prompt, pageTimeoutMs, country }) {
  const jsonFormat = { type: 'json' };
  if (schema !== undefined) jsonFormat.schema = schema;
  if (prompt !== undefined) jsonFormat.prompt = prompt;

  return {
    url,
    formats: [jsonFormat],
    onlyMainContent: true,
    timeout: pageTimeoutMs,
    maxAge: 0, // always fetch a fresh page; Firecrawl otherwise serves cached copies up to 2 days old
    location: { country },
  };
}

/**
 * @param {Object} [deps]
 * @param {Function} [deps.fetchImpl]  fetch implementation (default: global fetch)
 * @param {Function} [deps.getApiKey]  async () => string (default: Secrets Manager / .env loader)
 * @param {string}   [deps.baseUrl]    Firecrawl API base URL
 * @param {number}   [deps.timeoutMarginMs] extra client wait beyond the page timeout
 */
function createFirecrawlClient({
  fetchImpl = globalThis.fetch,
  getApiKey = getFirecrawlApiKey,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMarginMs = DEFAULT_TIMEOUT_MARGIN_MS,
} = {}) {
  /**
   * Scrapes one distributor product page and extracts JSON with Firecrawl.
   * @param {string} url
   * @param {ScrapeOptions} [options]
   * @returns {Promise<ScrapeResult>}  every request failure (timeout, blocked, http_error, ...) is returned
   *   here as a typed failure result, never thrown
   * @throws {TypeError} only for a programmer error: neither `options.schema` (an object) nor `options.prompt`
   *   (a non-empty string) was given. No request is sent in that case.
   */
  async function scrapeProductPage(url, options = {}) {
    const { schema, prompt } = options;
    if (!isPlainObject(schema) && (typeof prompt !== 'string' || prompt.trim().length === 0)) {
      throw new TypeError('scrapeProductPage requires options.schema (an object) or options.prompt (a string).');
    }

    if (!isValidHttpUrl(url)) {
      return failure(E.INVALID_URL, 'URL must be an absolute http(s) URL.');
    }

    let apiKey;
    try {
      apiKey = await getApiKey();
    } catch (err) {
      return failure(E.AUTH_ERROR, `Firecrawl API key could not be loaded: ${err && err.message ? err.message : 'unknown error'}`);
    }
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return failure(E.AUTH_ERROR, 'Firecrawl API key is empty.');
    }

    const sanitize = makeMessageSanitizer(apiKey);
    const pageTimeoutMs = clampPageTimeout(options.pageTimeoutMs);
    const country = typeof options.country === 'string' && options.country.trim() ? options.country.trim() : DEFAULT_COUNTRY;
    const body = buildRequestBody(url, {
      schema: isPlainObject(schema) ? schema : undefined,
      prompt: typeof prompt === 'string' && prompt.trim() ? prompt : undefined,
      pageTimeoutMs,
      country,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), pageTimeoutMs + timeoutMarginMs);

    let response;
    let rawText;
    try {
      response = await fetchImpl(`${baseUrl}/scrape`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      rawText = await response.text();
    } catch (err) {
      const aborted = controller.signal.aborted || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'));
      if (aborted) {
        return failure(E.TIMEOUT, `No response from Firecrawl within ${pageTimeoutMs + timeoutMarginMs} ms.`);
      }
      const cause = err && err.cause && err.cause.code ? ` (${err.cause.code})` : '';
      return failure(E.NETWORK_ERROR, sanitize(`Could not reach Firecrawl${cause}: ${err && err.message ? err.message : 'unknown error'}`));
    } finally {
      clearTimeout(timer);
    }

    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch (err) {
      parsed = null; // non-JSON body (e.g. a gateway error page); handled below
    }

    if (!response.ok) {
      return mapFirecrawlStatus(response.status, parsed, response.headers, sanitize);
    }

    if (!isPlainObject(parsed) || parsed.success !== true || !isPlainObject(parsed.data)) {
      return failure(E.HTTP_ERROR, sanitize(describeBody(parsed, 'Firecrawl response was not a successful scrape result.')), {
        httpStatus: response.status,
      });
    }

    const { data } = parsed;
    const metadata = isPlainObject(data.metadata) ? data.metadata : {};
    const targetStatusCode = Number.isInteger(metadata.statusCode) ? metadata.statusCode : undefined;
    const metadataError = typeof metadata.error === 'string' && metadata.error ? metadata.error : null;

    const targetFailure = mapTargetStatus(targetStatusCode, metadataError, response.status, sanitize);
    if (targetFailure) return targetFailure;

    if (!isPlainObject(data.json) || hasNoUsableValues(data.json)) {
      return failure(E.EMPTY_CONTENT, 'Firecrawl returned no usable JSON for this page.', {
        httpStatus: response.status,
        targetStatusCode,
      });
    }

    const creditsUsed = Number.isFinite(parsed.creditsUsed)
      ? parsed.creditsUsed
      : (Number.isFinite(metadata.creditsUsed) ? metadata.creditsUsed : undefined);

    const result = { ok: true, json: data.json, httpStatus: response.status };
    if (targetStatusCode !== undefined) result.targetStatusCode = targetStatusCode;
    if (creditsUsed !== undefined) result.creditsUsed = creditsUsed;
    return result;
  }

  return { scrapeProductPage };
}

const defaultClient = createFirecrawlClient();

module.exports = {
  scrapeProductPage: (url, options) => defaultClient.scrapeProductPage(url, options),
  createFirecrawlClient,
  DEFAULT_COUNTRY,
  DEFAULT_PAGE_TIMEOUT_MS,
};
