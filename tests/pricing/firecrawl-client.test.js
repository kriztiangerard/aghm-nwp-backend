'use strict';

// NWP-PRICE-007: Firecrawl wrapper. Runs with node:test (CI: node --test tests/pricing/*.test.js); no network calls.

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createFirecrawlClient } = require('../../src/pricing/firecrawl-client');
const { FIRECRAWL_ERROR_TYPES: E, isFirecrawlErrorType } = require('../../src/pricing/firecrawl-errors');

const API_KEY = 'fc-test-key-123';
const URL_OK = 'https://distributor.example.ph/collections/omada';
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

function scrapeBody({ json = { sku: 'ER605', price: '₱3,990.00' }, statusCode = 200, error = null } = {}) {
  return {
    success: true,
    data: { json, metadata: { sourceURL: URL_OK, statusCode, error } },
  };
}

function makeClient(responder, { apiKey = API_KEY } = {}) {
  const fetchImpl = mock.fn(responder);
  const getApiKey = mock.fn(async () => apiKey);
  const client = createFirecrawlClient({ fetchImpl, getApiKey, timeoutMarginMs: 0 });
  return { client, fetchImpl, getApiKey };
}

describe('scrapeProductPage: success', () => {
  test('returns the extracted JSON and sends a v2 JSON-format request', async () => {
    const { client, fetchImpl } = makeClient(async () => jsonResponse(200, scrapeBody()));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.deepEqual(result, {
      ok: true,
      json: { sku: 'ER605', price: '₱3,990.00' },
      httpStatus: 200,
      targetStatusCode: 200,
    });

    assert.equal(fetchImpl.mock.callCount(), 1);
    const [calledUrl, init] = fetchImpl.mock.calls[0].arguments;
    assert.equal(calledUrl, 'https://api.firecrawl.dev/v2/scrape');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(JSON.parse(init.body), {
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

    const sent = JSON.parse(fetchImpl.mock.calls[0].arguments[1].body);
    assert.deepEqual(sent.formats, [{ type: 'json', schema: SCHEMA, prompt: 'Extract the price.' }]);
    assert.equal(sent.timeout, 300000);
    assert.deepEqual(sent.location, { country: 'SG' });
  });

  test('reports creditsUsed when Firecrawl includes it', async () => {
    const body = scrapeBody();
    body.creditsUsed = 5;
    const { client } = makeClient(async () => jsonResponse(200, body));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.equal(result.creditsUsed, 5);
  });
});

describe('scrapeProductPage: input and configuration problems', () => {
  test('rejects a non-http URL without calling Firecrawl', async () => {
    const { client, fetchImpl } = makeClient(async () => jsonResponse(200, scrapeBody()));

    const result = await client.scrapeProductPage('ftp://distributor.example.ph/x', { schema: SCHEMA });

    assert.equal(result.ok, false);
    assert.equal(result.errorType, E.INVALID_URL);
    assert.equal(fetchImpl.mock.callCount(), 0);
  });

  test('returns auth_error when the API key cannot be loaded', async () => {
    const fetchImpl = mock.fn();
    const getApiKey = mock.fn(async () => { throw new Error('Neither FIRECRAWL_SECRET_ARN nor FIRECRAWL_API_KEY is set.'); });
    const client = createFirecrawlClient({ fetchImpl, getApiKey });

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.equal(result.errorType, E.AUTH_ERROR);
    assert.match(result.message, /FIRECRAWL_API_KEY/);
    assert.equal(fetchImpl.mock.callCount(), 0);
  });

  test('throws TypeError when neither schema nor prompt is given (programmer error)', async () => {
    const { client } = makeClient(async () => jsonResponse(200, scrapeBody()));

    await assert.rejects(client.scrapeProductPage(URL_OK, {}), TypeError);
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

  for (const [status, expected] of cases) {
    test(`HTTP ${status} maps to ${expected}`, async () => {
      const { client } = makeClient(async () => jsonResponse(status, { success: false, code: 'SOME_CODE', error: 'Something failed' }));

      const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

      assert.equal(result.ok, false);
      assert.equal(result.errorType, expected);
      assert.equal(result.httpStatus, status);
      assert.equal(result.message, 'SOME_CODE: Something failed');
    });
  }

  test('429 carries Retry-After in seconds', async () => {
    const { client } = makeClient(async () => jsonResponse(429, { error: 'Rate limit exceeded' }, { 'Retry-After': '30' }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.equal(result.errorType, E.RATE_LIMITED);
    assert.equal(result.retryAfterSeconds, 30);
  });

  test('a non-JSON error body does not throw', async () => {
    const { client } = makeClient(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.equal(result.errorType, E.HTTP_ERROR);
    assert.equal(result.httpStatus, 502);
  });

  test('a 200 response with success:false is an http_error', async () => {
    const { client } = makeClient(async () => jsonResponse(200, { success: false, error: 'Scrape failed' }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.equal(result.errorType, E.HTTP_ERROR);
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

  for (const [statusCode, expected] of cases) {
    test(`target status ${statusCode} maps to ${expected}`, async () => {
      const { client } = makeClient(async () => jsonResponse(200, scrapeBody({ statusCode, error: 'Access denied' })));

      const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

      assert.equal(result.ok, false);
      assert.equal(result.errorType, expected);
      assert.equal(result.targetStatusCode, statusCode);
      assert.ok(result.message.includes(String(statusCode)));
    });
  }
});

describe('scrapeProductPage: empty extraction', () => {
  const emptyCases = [
    ['missing json', undefined],
    ['empty object', {}],
    ['all null values', { sku: null, price: null }],
    ['blank strings', { sku: '  ', price: '' }],
    ['array instead of object', ['ER605']],
  ];

  for (const [label, json] of emptyCases) {
    test(`${label} is empty_content`, async () => {
      const body = scrapeBody();
      body.data.json = json;
      const { client } = makeClient(async () => jsonResponse(200, body));

      const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

      assert.equal(result.errorType, E.EMPTY_CONTENT);
    });
  }

  test('partial values are still returned (validation happens in NWP-PRICE-003)', async () => {
    const { client } = makeClient(async () => jsonResponse(200, scrapeBody({ json: { sku: 'ER605', price: null } })));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.equal(result.ok, true);
    assert.deepEqual(result.json, { sku: 'ER605', price: null });
  });

  test('a listing-page result (array of products) is returned as is', async () => {
    const products = { products: [{ sku: 'ER605', price: '₱3,990' }, { sku: 'EAP610', price: '₱3,450' }] };
    const { client } = makeClient(async () => jsonResponse(200, scrapeBody({ json: products })));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.equal(result.ok, true);
    assert.deepEqual(result.json, products);
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

    assert.equal(result.errorType, E.TIMEOUT);
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

    assert.equal(result.errorType, E.TIMEOUT);
  });

  test('a connection failure is a network_error', async () => {
    const { client } = makeClient(async () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ENOTFOUND' };
      throw err;
    });

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.equal(result.errorType, E.NETWORK_ERROR);
    assert.ok(result.message.includes('ENOTFOUND'));
  });
});

describe('scrapeProductPage: safety', () => {
  test('error messages never contain the API key', async () => {
    const { client } = makeClient(async () => jsonResponse(401, { success: false, error: `Invalid key ${API_KEY}` }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.ok(!result.message.includes(API_KEY));
    assert.ok(result.message.includes('[redacted]'));
  });

  test('long error messages are truncated', async () => {
    const { client } = makeClient(async () => jsonResponse(500, { success: false, error: 'x'.repeat(2000) }));

    const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });

    assert.ok(result.message.length < 600);
  });

  test('every failure uses a known error type', async () => {
    for (const status of [400, 401, 402, 403, 408, 429, 500, 504]) {
      const { client } = makeClient(async () => jsonResponse(status, { success: false }));
      // eslint-disable-next-line no-await-in-loop
      const result = await client.scrapeProductPage(URL_OK, { schema: SCHEMA });
      assert.equal(isFirecrawlErrorType(result.errorType), true, `HTTP ${status}`);
    }
  });
});

describe('scrapeProductPage: access walls served with HTTP 200 (AC5, QA: Shopee login page)', () => {
  const SHOPEE = 'https://shopee.ph/tplink.philippines';
  function wallBody({ json = { products: [{ sku: 'ER605', name: 'Omada ER605 Gigabit VPN Router', price: '₱3,990.00' }] }, ...meta } = {}) {
    return { success: true, data: { json, metadata: { sourceURL: SHOPEE, statusCode: 200, ...meta } } };
  }

  test('the real Shopee result (one item named "Login Required", price N/A) is blocked, not a success', async () => {
    const { client } = makeClient(async () => jsonResponse(200, wallBody({ json: { name: 'Login Required', price: 'N/A' } })));

    const result = await client.scrapeProductPage(SHOPEE, { schema: SCHEMA });

    assert.equal(result.ok, false);
    assert.equal(result.errorType, E.BLOCKED);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.targetStatusCode, 200);
    assert.match(result.message, /HTTP 200 but the page shows a login or bot-check message instead of products \("Login Required"\)/);
  });

  test('the same wall in the listing shape ({ products: [...] }) is blocked', async () => {
    const json = { products: [{ sku: '', name: 'Please log in to continue', price: '' }] };
    const { client } = makeClient(async () => jsonResponse(200, wallBody({ json })));
    assert.equal((await client.scrapeProductPage(SHOPEE, { schema: SCHEMA })).errorType, E.BLOCKED);
  });

  test('a redirect to a login page is blocked', async () => {
    const { client } = makeClient(async () => jsonResponse(200, wallBody({ url: 'https://shopee.ph/buyer/login?next=%2Ftplink.philippines' })));
    const result = await client.scrapeProductPage(SHOPEE, { schema: SCHEMA });
    assert.equal(result.errorType, E.BLOCKED);
    assert.match(result.message, /redirected to a login or bot-check page \(\/buyer\/login\)/);
  });

  for (const title of ['Login Now to Start Shopping | Shopee Philippines', 'Attention Required! | Cloudflare', 'Just a moment... verify you are human']) {
    test(`a wall title is blocked: "${title}"`, async () => {
      const { client } = makeClient(async () => jsonResponse(200, wallBody({ title })));
      assert.equal((await client.scrapeProductPage(SHOPEE, { schema: SCHEMA })).errorType, E.BLOCKED);
    });
  }

  test('an empty extraction from a login page is reported as blocked, not empty_content', async () => {
    const { client } = makeClient(async () => jsonResponse(200, wallBody({ json: { products: [] }, title: 'Sign in | Store' })));
    assert.equal((await client.scrapeProductPage(SHOPEE, { schema: SCHEMA })).errorType, E.BLOCKED);
  });

  test('a real listing is not affected: normal title, same URL, real products', async () => {
    const json = { products: [
      { sku: 'OC200', name: 'Omada Hardware Controller OC200', price: '₱4,390.00' },
      { sku: 'ER605', name: 'Omada ER605 Gigabit VPN Router', price: '₱3,990.00' },
    ] };
    const { client } = makeClient(async () => jsonResponse(200, wallBody({ json, title: 'TP-Link Omada | Store', url: SHOPEE })));
    const result = await client.scrapeProductPage(SHOPEE, { schema: SCHEMA });
    assert.equal(result.ok, true);
    assert.deepEqual(result.json, json);
  });

  test('one oddly named item among real products does not make the page a wall', async () => {
    const json = { products: [
      { sku: 'X1', name: 'Login Required', price: 'N/A' },
      { sku: 'ER605', name: 'Omada ER605 Gigabit VPN Router', price: '₱3,990.00' },
    ] };
    const { client } = makeClient(async () => jsonResponse(200, wallBody({ json })));
    assert.equal((await client.scrapeProductPage(SHOPEE, { schema: SCHEMA })).ok, true);
  });

  test('product names that only contain wall-like words are not walls', async () => {
    const json = { products: [{ sku: 'EAP', name: 'Access Point with Captive Portal Sign-In Page', price: '₱5,000' }] };
    const { client } = makeClient(async () => jsonResponse(200, wallBody({ json, title: 'Access Points | Store' })));
    assert.equal((await client.scrapeProductPage(SHOPEE, { schema: SCHEMA })).ok, true);
  });

  test('a store whose own URL contains /auth is not treated as a redirect', async () => {
    const authUrl = 'https://store.example.ph/auth/omada';
    const { client } = makeClient(async () => jsonResponse(200, { success: true, data: { json: { sku: 'ER605', price: '₱3,990.00' }, metadata: { sourceURL: authUrl, url: authUrl, statusCode: 200 } } }));
    assert.equal((await client.scrapeProductPage(authUrl, { schema: SCHEMA })).ok, true);
  });
});
