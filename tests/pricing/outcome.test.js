'use strict';

// NWP-PRICE-004: failure isolation (retry, account-level stop, per-page and per-device isolation),
// attribution of outcomes, update_log rows and the run result. No network and no database.

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { processSourceBatch, retryDelayMs, MAX_RETRY_DELAY_MS } = require('../../src/pricing/collect');
const { attributeOutcomes, recordBatchOutcome, loadTrackedRows, getRunResult } = require('../../src/pricing/outcome');
const {
  SYNC_STATUS, RETRYABLE, ACCOUNT_LEVEL, isSyncStatus, fromFirecrawlError, fromRejectReason,
} = require('../../src/pricing/sync-status');
const { FIRECRAWL_ERROR_TYPES } = require('../../src/pricing/firecrawl-errors');
const { NORMALIZE_REJECT_REASONS, buildSkuIndex } = require('../../src/pricing/normalize-record');

const RUN_AT = '2026-11-23T02:00:00.000Z';
const SKU_INDEX = buildSkuIndex([
  { deviceId: 11, sku: 'ER605' },
  { deviceId: 12, sku: 'EAP610' },
  { deviceId: 13, sku: 'SG2008P' },
]);
const URL1 = 'https://store.example/omada?page=1';
const URL2 = 'https://store.example/omada?page=2';
const URL3 = 'https://store.example/omada?page=3';

function batch(urls = [URL1, URL2], overrides = {}) {
  return {
    runAt: RUN_AT, vendorId: 1, distributorId: 7,
    sources: urls.map((sourceUrl, i) => ({ sourceId: 101 + i, sourceUrl })),
    ...overrides,
  };
}

const ok = (products) => ({ ok: true, json: { products }, httpStatus: 200 });
const fail = (errorType, extra = {}) => ({ ok: false, errorType, message: `${errorType} detail`, ...extra });

/** url -> list of results returned on successive calls (a single result repeats). */
function scripted(byUrl) {
  const calls = new Map();
  return mock.fn(async (url) => {
    const plan = byUrl[url];
    if (plan === undefined) throw new Error(`unexpected url ${url}`);
    if (typeof plan === 'function') return plan();
    const list = Array.isArray(plan) ? plan : [plan];
    const n = calls.get(url) || 0;
    calls.set(url, n + 1);
    return list[Math.min(n, list.length - 1)];
  });
}

function deps(scrape, extra = {}) {
  const lines = [];
  return {
    lines,
    deps: {
      scrape,
      concurrency: 1,
      loadSkuIndex: async () => SKU_INDEX,
      withTransaction: async (work) => work({}),
      upsertPrice: async (client, record) => ({ pricingId: record.deviceId, inserted: true }),
      markSyncSuccess: async () => {},
      now: () => new Date('2026-11-23T02:01:00Z'),
      sleep: extra.sleep || (async () => {}),
      logger: { log: (line) => lines.push(JSON.parse(line)) },
      ...extra,
    },
  };
}

describe('SYNC_STATUS', () => {
  test('maps every Firecrawl error type and normalizer reason one-to-one', () => {
    for (const type of Object.values(FIRECRAWL_ERROR_TYPES)) {
      assert.equal(fromFirecrawlError(type), type);
      assert.ok(isSyncStatus(type));
    }
    assert.equal(fromRejectReason(NORMALIZE_REJECT_REASONS.MISSING_FIELD), 'missing_field');
    assert.equal(fromRejectReason(NORMALIZE_REJECT_REASONS.INVALID_PRICE), 'invalid_price');
    assert.equal(fromFirecrawlError('something_new'), SYNC_STATUS.UNEXPECTED_ERROR);
    assert.equal(fromRejectReason('no_sku_match'), SYNC_STATUS.UNEXPECTED_ERROR);   // never logged
  });

  test('has the statuses the story lists, and is frozen', () => {
    assert.deepEqual(Object.values(SYNC_STATUS).sort(), [
      'auth_error', 'blocked', 'db_error', 'empty_content', 'http_error', 'invalid_price', 'invalid_response',
      'invalid_url', 'missing_field', 'network_error', 'not_listed', 'quota_exceeded', 'rate_limited',
      'success', 'timeout', 'unexpected_error',
    ]);
    assert.ok(Object.isFrozen(SYNC_STATUS));
    assert.deepEqual([...RETRYABLE].sort(), ['rate_limited', 'timeout']);
    assert.deepEqual([...ACCOUNT_LEVEL].sort(), ['auth_error', 'network_error', 'quota_exceeded']);
  });
});

describe('retry policy', () => {
  test('a timeout is retried once and the retry can succeed', async () => {
    const scrape = scripted({ [URL1]: [fail('timeout'), ok([{ sku: 'ER605', price: '₱3,500.00' }])] });
    const sleep = mock.fn(async () => {});
    const { deps: d } = deps(scrape, { sleep });

    const summary = await processSourceBatch(batch([URL1]), d);

    assert.equal(scrape.mock.callCount(), 2);
    assert.deepEqual(sleep.mock.calls.map((c) => c.arguments[0]), [2000]);
    assert.equal(summary.pages[0].status, 'success');
    assert.equal(summary.pages[0].attempts, 2);
    assert.deepEqual(summary.found, [11]);
  });

  test('a second failure is kept, with 2 attempts', async () => {
    const scrape = scripted({ [URL1]: fail('rate_limited', { retryAfterSeconds: 3 }) });
    const sleep = mock.fn(async () => {});
    const { deps: d } = deps(scrape, { sleep });

    const summary = await processSourceBatch(batch([URL1]), d);

    assert.equal(scrape.mock.callCount(), 2);
    assert.deepEqual(sleep.mock.calls.map((c) => c.arguments[0]), [3000]);   // Retry-After used
    assert.equal(summary.pages[0].status, 'rate_limited');
    assert.equal(summary.pages[0].attempts, 2);
  });

  test('blocked and other errors are never retried', async () => {
    for (const type of ['blocked', 'http_error', 'invalid_url', 'empty_content']) {
      const scrape = scripted({ [URL1]: fail(type) });
      const { deps: d } = deps(scrape);
      // eslint-disable-next-line no-await-in-loop
      const summary = await processSourceBatch(batch([URL1]), d);
      assert.equal(scrape.mock.callCount(), 1, type);
      assert.equal(summary.pages[0].attempts, 1, type);
    }
  });

  test('backoff: Retry-After is capped; defaults when absent', () => {
    assert.equal(retryDelayMs({ errorType: 'rate_limited', retryAfterSeconds: 600 }), MAX_RETRY_DELAY_MS);
    assert.equal(retryDelayMs({ errorType: 'rate_limited' }), 5000);
    assert.equal(retryDelayMs({ errorType: 'timeout' }), 2000);
  });
});

describe('page isolation', () => {
  test('a failed page is recorded and the remaining pages are processed (AC1)', async () => {
    const scrape = scripted({
      [URL1]: fail('blocked'),
      [URL2]: ok([{ sku: 'EAP610', price: '₱5,200.00' }]),
      [URL3]: fail('http_error'),
    });
    const { deps: d } = deps(scrape);

    const summary = await processSourceBatch(batch([URL1, URL2, URL3]), d);

    assert.deepEqual(summary.pages.map((p) => p.status), ['blocked', 'success', 'http_error']);
    assert.deepEqual(summary.found, [12]);
    assert.equal(summary.stoppedBy, null);
  });

  test('an exception while processing one page is isolated as unexpected_error', async () => {
    const scrape = scripted({
      [URL1]: () => { throw new Error('boom'); },
      [URL2]: ok([{ sku: 'EAP610', price: '₱5,200.00' }]),
    });
    const { deps: d } = deps(scrape);

    const summary = await processSourceBatch(batch(), d);

    assert.equal(summary.pages[0].status, 'unexpected_error');
    assert.match(summary.pages[0].message, /boom/);
    assert.deepEqual(summary.found, [12]);
  });

  test('an account-level error stops the batch and skips the pages not yet started', async () => {
    for (const type of ['auth_error', 'quota_exceeded', 'network_error']) {
      const scrape = scripted({ [URL1]: fail(type), [URL2]: ok([]), [URL3]: ok([]) });
      const { deps: d } = deps(scrape);
      // eslint-disable-next-line no-await-in-loop
      const summary = await processSourceBatch(batch([URL1, URL2, URL3]), d);

      assert.equal(scrape.mock.callCount(), 1, type);
      assert.deepEqual(summary.stoppedBy, { status: type, sourceId: 101, message: `${type} detail` });
      assert.deepEqual(summary.pages.map((p) => p.status), [type, 'skipped', 'skipped']);
      assert.match(summary.pages[1].message, new RegExp(`stopped after ${type}`));
    }
  });

  test('writes one log line per page with runAt, sourceId, status, productCount and matched', async () => {
    const scrape = scripted({ [URL1]: ok([{ sku: 'ER605', price: '₱3,500.00' }, { sku: 'X', price: '1' }]), [URL2]: fail('blocked') });
    const { deps: d, lines } = deps(scrape);

    await processSourceBatch(batch(), d);

    assert.deepEqual(lines, [
      { source: 'price-updater', event: 'page', runAt: RUN_AT, sourceId: 101, status: 'success', productCount: 2, matched: 1, attempts: 1 },
      { source: 'price-updater', event: 'page', runAt: RUN_AT, sourceId: 102, status: 'blocked', productCount: 0, matched: 0, attempts: 1 },
    ]);
  });

  test('one distributor failing does not stop another distributor\'s price being stored (AC2)', async () => {
    const stored = [];
    const upsertPrice = async (client, record) => { stored.push([record.distributorId, record.deviceId]); return { inserted: true }; };
    const failing = scripted({ [URL1]: fail('blocked') });
    const working = scripted({ [URL2]: ok([{ sku: 'ER605', price: '₱3,600.00' }]) });

    await processSourceBatch(batch([URL1], { distributorId: 7 }), deps(failing, { upsertPrice }).deps);
    await processSourceBatch({ ...batch([URL2]), distributorId: 8, sources: [{ sourceId: 201, sourceUrl: URL2 }] },
      deps(working, { upsertPrice }).deps);

    assert.deepEqual(stored, [[8, 11]]);
  });
});

describe('attributeOutcomes', () => {
  const pages = (statuses) => statuses.map(([sourceId, status]) => ({ sourceId, status, message: `${status} detail` }));

  test('applies each rule from the story', () => {
    const summary = {
      pages: pages([[101, 'success'], [102, 'blocked']]),
      found: [11],
      rejected: [{ deviceId: 12, reason: 'invalid_price', detail: 'Call for price' }],
      dbErrors: [{ deviceId: 14, detail: 'Storing the price failed: x' }],
      stoppedBy: null,
    };
    const tracked = [
      { deviceId: 11, sourceId: 101 },   // found -> success
      { deviceId: 12, sourceId: 101 },   // rejected -> invalid_price
      { deviceId: 13, sourceId: 101 },   // page ok, not found -> not_listed
      { deviceId: 15, sourceId: 102 },   // page blocked, not found -> blocked
    ];

    const outcomes = attributeOutcomes(summary, tracked);

    assert.deepEqual(outcomes.map((o) => [o.deviceId, o.status]), [
      [11, 'success'], [12, 'invalid_price'], [13, 'not_listed'], [14, 'db_error'], [15, 'blocked'],
    ]);
    assert.equal(outcomes[0].error, null);
    assert.equal(outcomes[1].error, 'Call for price');
    assert.match(outcomes[2].error, /No longer listed.*source 101/);
    assert.match(outcomes[4].error, /Source 102 failed: blocked detail/);
  });

  test('a device found on another page is a success even though its own page failed', () => {
    const summary = { pages: pages([[101, 'blocked'], [102, 'success']]), found: [11], rejected: [], dbErrors: [], stoppedBy: null };
    assert.deepEqual(attributeOutcomes(summary, [{ deviceId: 11, sourceId: 101 }]).map((o) => o.status), ['success']);
  });

  test('records nothing for a device never priced from this distributor and not found', () => {
    const summary = { pages: pages([[101, 'success']]), found: [], rejected: [], dbErrors: [], stoppedBy: null };
    assert.deepEqual(attributeOutcomes(summary, []), []);
  });

  test('after an account-level stop, unfound devices are not attributed (no stale marking)', () => {
    const summary = {
      pages: pages([[101, 'success'], [102, 'quota_exceeded'], [103, 'skipped']]),
      found: [11], rejected: [], dbErrors: [],
      stoppedBy: { status: 'quota_exceeded', sourceId: 102, message: 'x' },
    };
    const tracked = [{ deviceId: 11, sourceId: 101 }, { deviceId: 12, sourceId: 101 }, { deviceId: 13, sourceId: 102 }];

    assert.deepEqual(attributeOutcomes(summary, tracked).map((o) => [o.deviceId, o.status]), [[11, 'success']]);
  });
});

describe('recordBatchOutcome', () => {
  function fakeClient(trackedRows) {
    const inserts = [];
    const query = mock.fn(async (sql, params) => {
      if (/FROM pricing/.test(sql)) return { rows: trackedRows };
      if (/INSERT INTO update_log/.test(sql)) { inserts.push(params); return { rows: [] }; }
      throw new Error(`unexpected sql ${sql}`);
    });
    return { client: { query }, inserts, query };
  }

  const summary = {
    runAt: RUN_AT, vendorId: 1, distributorId: 7,
    pages: [{ sourceId: 101, status: 'success' }, { sourceId: 102, status: 'timeout', message: 'slow' }],
    found: [11], rejected: [], dbErrors: [], stoppedBy: null,
  };

  test('writes exactly one update_log row per device with the run\'s runAt (AC3)', async () => {
    const { client, inserts, query } = fakeClient([
      { device_id: 11, source_id: 101 }, { device_id: 12, source_id: 101 }, { device_id: 13, source_id: 102 },
    ]);
    const markSyncFailure = mock.fn(async () => {});

    const result = await recordBatchOutcome(client, summary, { markSyncFailure });

    assert.deepEqual(inserts.map(([distributorId, deviceId, status, , runAt]) => [distributorId, deviceId, status, runAt]), [
      [7, 11, 'success', RUN_AT], [7, 12, 'not_listed', RUN_AT], [7, 13, 'timeout', RUN_AT],
    ]);
    assert.deepEqual(result, { recorded: 3, byStatus: { success: 1, not_listed: 1, timeout: 1 } });
    const insertSql = query.mock.calls.find((c) => /INSERT INTO update_log/.test(c.arguments[0])).arguments[0];
    assert.match(insertSql, /\(distributor_id, device_id, status, error, run_at\)/);
    assert.doesNotMatch(insertSql, /upd_log_id/);
  });

  test('calls markSyncFailure for every non-success, never for a success (AC4)', async () => {
    const { client } = fakeClient([{ device_id: 11, source_id: 101 }, { device_id: 12, source_id: 101 }, { device_id: 13, source_id: 102 }]);
    const markSyncFailure = mock.fn(async () => {});

    await recordBatchOutcome(client, summary, { markSyncFailure });

    assert.deepEqual(markSyncFailure.mock.calls.map((c) => c.arguments[1]), [
      { deviceId: 12, distributorId: 7 }, { deviceId: 13, distributorId: 7 },
    ]);
  });

  test('loadTrackedRows reads synchronized rows of the batch\'s pages only', async () => {
    const query = mock.fn(async () => ({ rows: [{ device_id: '11', source_id: '101' }] }));

    const rows = await loadTrackedRows({ query }, { vendorId: 1, distributorId: 7, sourceIds: [101, 102] });

    assert.deepEqual(rows, [{ deviceId: 11, sourceId: 101 }]);
    const [sql, params] = query.mock.calls[0].arguments;
    assert.match(sql, /p\.source_id = ANY\(\$3::int\[\]\)/);   // manual rows (NULL) never match
    assert.deepEqual(params, [7, 1, [101, 102]]);
    assert.deepEqual(await loadTrackedRows({ query }, { vendorId: 1, distributorId: 7, sourceIds: [] }), []);
  });
});

describe('getRunResult', () => {
  test('successful when at least one row of the run is success', async () => {
    const query = mock.fn(async () => ({ rows: [{ status: 'blocked', count: 4 }, { status: 'success', count: 1 }] }));
    assert.deepEqual(await getRunResult({ query }, RUN_AT), {
      runAt: RUN_AT, successful: true, rows: 5, byStatus: { blocked: 4, success: 1 },
    });
    assert.deepEqual(query.mock.calls[0].arguments[1], [RUN_AT]);
  });

  test('unsuccessful when every source failed, or nothing was recorded (AC7)', async () => {
    const allFailed = mock.fn(async () => ({ rows: [{ status: 'blocked', count: 3 }, { status: 'timeout', count: 2 }] }));
    assert.equal((await getRunResult({ query: allFailed }, RUN_AT)).successful, false);
    const none = mock.fn(async () => ({ rows: [] }));
    assert.deepEqual(await getRunResult({ query: none }, RUN_AT), { runAt: RUN_AT, successful: false, rows: 0, byStatus: {} });
  });
});