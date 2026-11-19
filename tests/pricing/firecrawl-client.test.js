'use strict';

const { createFirecrawlClient } = require('../../src/pricing/firecrawl-client');
const { FIRECRAWL_ERROR_TYPES: E, isFirecrawlErrorType } = require('../../src/pricing/firecrawl-errors');

const API_KEY = 'fc-test-key-123';
const URL_OK = 'https://distributor.example.ph/products/er605';
const SCHEMA = {
  type: 'object',
  properties: { sku: { type: 'string' }, price: { type: 'string' } },
  required: ['sku', 'price'],
};

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function scrapeBody({ json = { sku: 'ER605', price: '₱3,990.00' }, statusCode = 200, error = null, extra = {} } = {}) {
  return {
    success: true,
    data: { json, metadata: { sourceURL: URL_OK, statusCode, error }, ...extra },
  };
}

function makeClient(responder, { apiKey = API_KEY } = {}) {
  const fetchImpl = jest.fn(responder);
  const getApiKey = jest.fn(async () => apiKey);
  const client = createFirecrawlClient({ fetchImpl, getApiKey, timeoutMarginMs: 0 });
  return { client, fetchImpl, getApiKey };
}

describe('scrapeProductPage: success', () => {
  test('returns the extracted JSON and sends a v2 JSON-format request', async () => {
    const { client, fetchImpl } = makeClient(async () => jsonResponse(200, scrapeBody({ extra: {} })));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result).toEqual({
      ok: true,
      json: { sku: 'ER605', price: '₱3,990.00' },
      httpStatus: 200,
      targetStatusCode: 200,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe('https://api.firecrawl.dev/v2/scrape');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);

    const sent = JSON.parse(init.body);
    expect(sent).toEqual({
      url: URL_OK,
      formats: [{ type: 'json', schema: SCHEMA }],
      onlyMainContent: true,
      timeout: 60000,
      maxAge: 0,
      location: { country: 'PH' },
    });
  });

  test('passes prompt, page timeout (clamped) and country through', async () => {
    const { client, fetchImpl } = makeClient(async () => jsonResponse(200, scrapeBody()));

    await client.scrapeProductPage(URL_OK, { schema: SCHEMA, prompt: 'Extract the price.', pageTimeoutMs: 999999, country: 'SG' });

    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sent.formats).toEqual([{ type: 'json', schema: SCHEMA, prompt: 'Extract the price.' }]);
    expect(sent.timeout).toBe(300000);
    expect(sent.location).toEqual({ country: 'SG' });
  });

  test('reports creditsUsed when Firecrawl includes it', async () => {
    const body = scrapeBody();
    body.creditsUsed = 5;
    const { client } = makeClient(async () => jsonResponse(200, body));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.creditsUsed).toBe(5);
  });
});

describe('scrapeProductPage: input and configuration problems', () => {
  test('rejects a non-http URL without calling Firecrawl', async () => {
    const { client, fetchImpl } = makeClient(async () => jsonResponse(200, scrapeBody()));

    const result = await client.scrapeProductPage('ftp://distributor.example.ph/x', { schema: SCHEMA });

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe(E.INVALID_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  test('returns auth_error when the API key cannot be loaded', async () => {
    const fetchImpl = jest.fn();
    const getApiKey = jest.fn(async () => { throw new Error('Neither FIRECRAWL_SECRET_ARN nor FIRECRAWL_API_KEY is set.'); });
    const client = createFirecrawlClient({ fetchImpl, getApiKey });

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.errorType).toBe(E.AUTH_ERROR);
    expect(result.message).toMatch(/FIRECRAWL_API_KEY/);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  test('throws TypeError when neither schema nor prompt is given (programmer error)', async () => {
    const { client } = makeClient(async () => jsonResponse(200, scrapeBody()));

    await expect(client.scrapeProductPage(URL_OK, {})).rejects.toThrow(TypeError);
  });
});

describe('scrapeProductPage: Firecrawl HTTP errors', () => {
  const cases = [
    [401, E.AUTH_ERROR],
    [402, E.QUOTA_EXCEEDED],
    [403, E.BLOCKED],
    [408, E.TIMEOUT],
    [429, E.RATE_LIMITED],
    [400, E.HTTP_ERROR],
    [500, E.HTTP_ERROR],
    [503, E.HTTP_ERROR],
    [504, E.TIMEOUT],
  ];

  cases.forEach(([status, expected]) => {
    test(`HTTP ${status} maps to ${expected}`, async () => {
      const { client } = makeClient(async () => jsonResponse(status, { success: false, code: 'SOME_CODE', error: 'Something failed' }));

      const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

      expect(result.ok).toBe(false);
      expect(result.errorType).toBe(expected);
      expect(result.httpStatus).toBe(status);
      expect(result.message).toBe('SOME_CODE: Something failed');
    });
  });

  test('429 carries Retry-After in seconds', async () => {
    const { client } = makeClient(async () => jsonResponse(429, { error: 'Rate limit exceeded' }, { 'Retry-After': '30' }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.errorType).toBe(E.RATE_LIMITED);
    expect(result.retryAfterSeconds).toBe(30);
  });

  test('a non-JSON error body does not throw', async () => {
    const { client } = makeClient(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.errorType).toBe(E.HTTP_ERROR);
    expect(result.httpStatus).toBe(502);
  });

  test('a 200 response with success:false is an http_error', async () => {
    const { client } = makeClient(async () => jsonResponse(200, { success: false, error: 'Scrape failed' }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.errorType).toBe(E.HTTP_ERROR);
  });
});

describe('scrapeProductPage: distributor site status', () => {
  const cases = [
    [403, E.BLOCKED],
    [401, E.BLOCKED],
    [429, E.BLOCKED],
    [404, E.INVALID_URL],
    [410, E.INVALID_URL],
    [500, E.HTTP_ERROR],
  ];

  cases.forEach(([statusCode, expected]) => {
    test(`target status ${statusCode} maps to ${expected}`, async () => {
      const { client } = makeClient(async () => jsonResponse(200, scrapeBody({ statusCode, error: 'Access denied' })));

      const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

      expect(result.ok).toBe(false);
      expect(result.errorType).toBe(expected);
      expect(result.targetStatusCode).toBe(statusCode);
      expect(result.message).toContain(String(statusCode));
    });
  });
});

describe('scrapeProductPage: empty extraction', () => {
  const emptyCases = [
    ['missing json', undefined],
    ['empty object', {}],
    ['all null values', { sku: null, price: null }],
    ['blank strings', { sku: '  ', price: '' }],
    ['array instead of object', ['ER605']],
  ];

  emptyCases.forEach(([label, json]) => {
    test(`${label} is empty_content`, async () => {
      const body = scrapeBody();
      body.data.json = json;
      const { client } = makeClient(async () => jsonResponse(200, body));

      const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

      expect(result.errorType).toBe(E.EMPTY_CONTENT);
    });
  });

  test('partial values are still returned (validation happens in NWP-PRICE-003)', async () => {
    const { client } = makeClient(async () => jsonResponse(200, scrapeBody({ json: { sku: 'ER605', price: null } })));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.ok).toBe(true);
    expect(result.json).toEqual({ sku: 'ER605', price: null });
  });
});

describe('scrapeProductPage: transport failures', () => {
  test('an aborted request is a timeout', async () => {
    const { client } = makeClient(async () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.errorType).toBe(E.TIMEOUT);
  });

  test('the client aborts when Firecrawl does not answer in time', async () => {
    const { client } = makeClient((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA, pageTimeoutMs: 1000 });

    expect(result.errorType).toBe(E.TIMEOUT);
  });

  test('a connection failure is a network_error', async () => {
    const { client } = makeClient(async () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ENOTFOUND' };
      throw err;
    });

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.errorType).toBe(E.NETWORK_ERROR);
    expect(result.message).toContain('ENOTFOUND');
  });
});

describe('scrapeProductPage: safety', () => {
  test('error messages never contain the API key', async () => {
    const { client } = makeClient(async () => jsonResponse(401, { success: false, error: `Invalid key ${API_KEY}` }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.message).not.toContain(API_KEY);
    expect(result.message).toContain('[redacted]');
  });

  test('long error messages are truncated', async () => {
    const { client } = makeClient(async () => jsonResponse(500, { success: false, error: 'x'.repeat(2000) }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    expect(result.message.length).toBeLessThan(600);
  });

  test('every failure uses a known error type', async () => {
    const statuses = [400, 401, 402, 403, 408, 429, 500, 504];
    for (const status of statuses) {
      const { client } = makeClient(async () => jsonResponse(status, { success: false }));
      // eslint-disable-next-line no-await-in-loop
      const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });
      expect(isFirecrawlErrorType(result.errorType)).toBe(true);
    }
  });
});
