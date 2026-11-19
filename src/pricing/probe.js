'use strict';

// NWP-PRICE-010: checks that the Price updater can reach the internet (through the fck-nat instance) before
// a sync run starts scraping. The weekly workflow (NWP-PRICE-011) calls the `probe` action after starting the
// NAT instance and retries it with backoff until it passes.
//
// One unauthenticated GET to the Firecrawl API host: any HTTP response, whatever its status, proves that
// outbound HTTPS works. It sends no API key and spends no credits. A connection failure or timeout throws
// ProbeFailedError, so a Step Functions Retry on that error name can wait for the NAT instance.

const DEFAULT_PROBE_URL = 'https://api.firecrawl.dev/';
const DEFAULT_TIMEOUT_MS = 10000;

class ProbeFailedError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'ProbeFailedError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl]  default: global fetch
 * @param {string}   [options.url]
 * @param {number}   [options.timeoutMs]
 * @param {Function} [options.now]        clock in ms (tests)
 * @returns {Promise<{ ok: true, url: string, httpStatus: number, elapsedMs: number }>}
 * @throws {ProbeFailedError}
 */
async function probeOutbound({
  fetchImpl = globalThis.fetch,
  url = DEFAULT_PROBE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (response && response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel().catch(() => {});   // the body is not needed
    }
    return { ok: true, url, httpStatus: response.status, elapsedMs: now() - startedAt };
  } catch (error) {
    const aborted = controller.signal.aborted || (error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
    const code = error && error.cause && error.cause.code ? ` (${error.cause.code})` : '';
    const reason = aborted ? `no response within ${timeoutMs} ms` : `${error && error.message ? error.message : 'unknown error'}${code}`;
    throw new ProbeFailedError(`Outbound check to ${url} failed: ${reason}. Is the fck-nat instance running?`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  probeOutbound,
  ProbeFailedError,
  DEFAULT_PROBE_URL,
};
