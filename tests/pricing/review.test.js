'use strict';

// NWP-PRICE-006: manual-review evaluation, the review list, the run summary and manual prices.
// No database: pg is replaced with fakes. The SQL's behaviour (the every-row rule, idempotence, the
// manual-price upsert) was also checked on PostgreSQL 16 (see the NWP-PRICE-006 writeup).

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateManualReview } = require('../../src/pricing/pricing-state');
const {
  devicesInRun, countDevicesNeedingReview, listDevicesNeedingReview, buildRunSummary,
} = require('../../src/pricing/review');
const { setManualPrice, ManualPriceError } = require('../../src/pricing/manual');
const constants = require('../../src/pricing/constants');

const RUN_AT = '2026-11-23T02:00:00.000Z';

describe('constants', () => {
  test('MANUAL_REVIEW_THRESHOLD is 3 and frozen', () => {
    assert.equal(constants.MANUAL_REVIEW_THRESHOLD, 3);
    assert.ok(Object.isFrozen(constants));
  });
});

describe('evaluateManualReview', () => {
  test('flags a device only when every synchronized row reached the threshold (AC2, AC3)', async () => {
    const query = mock.fn(async () => ({
      rows: [
        { device_id: 11, needs_review: true }, { device_id: 11, needs_review: true },
        { device_id: 12, needs_review: false }, { device_id: 12, needs_review: false },
      ],
    }));

    const result = await evaluateManualReview({ query }, [12, 11, 11]);

    assert.deepEqual(result, { flagged: [11], notFlagged: [12] });
    const [sql, params] = query.mock.calls[0].arguments;
    assert.match(sql, /bool_and\(consecutive_failure_count >= \$2\) FILTER \(WHERE source_id IS NOT NULL\)/);  // only synchronized rows count
    assert.match(sql, /AND NOT bool_or\(source_id IS NULL\) AS needs_review/);    // a manual price clears the flag
    assert.match(sql, /HAVING bool_or\(source_id IS NOT NULL\)/);                  // manual-only devices left alone
    assert.match(sql, /SET needs_manual_review = decision\.needs_review/);          // sets true OR false: clears too (AC5)
    assert.match(sql, /AND p\.source_id IS NOT NULL/);                               // manual rows never flagged
    assert.doesNotMatch(sql, /INSERT|DELETE/);
    assert.deepEqual(params, [[12, 11], 3]);
  });

  test('does nothing for an empty list, and validates its input', async () => {
    const query = mock.fn();
    assert.deepEqual(await evaluateManualReview({ query }, []), { flagged: [], notFlagged: [] });
    await assert.rejects(evaluateManualReview({ query }, ['11']), TypeError);
    await assert.rejects(evaluateManualReview({ query }, [11], { threshold: 0 }), TypeError);
    assert.equal(query.mock.callCount(), 0);
  });

  test('accepts another threshold', async () => {
    const query = mock.fn(async () => ({ rows: [] }));
    await evaluateManualReview({ query }, [11], { threshold: 5 });
    assert.deepEqual(query.mock.calls[0].arguments[1], [[11], 5]);
  });
});

describe('review queries', () => {
  test('devicesInRun returns the run\'s devices', async () => {
    const query = mock.fn(async () => ({ rows: [{ device_id: '11' }, { device_id: '12' }] }));
    assert.deepEqual(await devicesInRun({ query }, RUN_AT), [11, 12]);
    assert.deepEqual(query.mock.calls[0].arguments[1], [RUN_AT]);
  });

  test('countDevicesNeedingReview counts distinct flagged devices', async () => {
    const query = mock.fn(async () => ({ rows: [{ count: 2 }] }));
    assert.equal(await countDevicesNeedingReview({ query }), 2);
    assert.match(query.mock.calls[0].arguments[0], /COUNT\(DISTINCT device_id\)[\s\S]*WHERE needs_manual_review/);
  });

  test('listDevicesNeedingReview lists each flagged device with every distributor\'s latest status (AC6)', async () => {
    const query = mock.fn(async (sql) => {
      if (/FROM device AS d/.test(sql)) {
        return { rows: [{ device_id: 11, vendor: 'TP-Link Omada', sku: 'ER605', name: 'Router', price: '3500.00', price_updated_at: null }] };
      }
      return {
        rows: [
          { device_id: 11, distributor_id: 3, distributor: 'PC Express', price: '3600.00', source_id: 9, is_stale: true,
            consecutive_failure_count: 3, status: 'blocked', error: 'captcha', run_at: '2026-11-23T02:00:00Z' },
          { device_id: 11, distributor_id: 5, distributor: 'Villman', price: '3500.00', source_id: 4, is_stale: true,
            consecutive_failure_count: 4, status: 'not_listed', error: 'gone', run_at: '2026-11-23T02:00:00Z' },
        ],
      };
    });

    const devices = await listDevicesNeedingReview({ query });

    assert.deepEqual(devices, [{
      deviceId: 11, vendor: 'TP-Link Omada', sku: 'ER605', name: 'Router', price: '3500.00', priceUpdatedAt: null,
      distributors: [
        { distributorId: 3, distributor: 'PC Express', price: '3600.00', manual: false, isStale: true, consecutiveFailures: 3,
          latestStatus: 'blocked', latestError: 'captcha', latestRunAt: '2026-11-23T02:00:00Z' },
        { distributorId: 5, distributor: 'Villman', price: '3500.00', manual: false, isStale: true, consecutiveFailures: 4,
          latestStatus: 'not_listed', latestError: 'gone', latestRunAt: '2026-11-23T02:00:00Z' },
      ],
    }]);
    const linesSql = query.mock.calls[1].arguments[0];
    assert.match(linesSql, /LEFT JOIN LATERAL[\s\S]*ORDER BY u\.run_at DESC, u\.upd_log_id DESC\s+LIMIT 1/);   // latest only
    assert.deepEqual(query.mock.calls[1].arguments[1], [[11]]);
  });

  test('listDevicesNeedingReview returns [] without a second query when nothing is flagged', async () => {
    const query = mock.fn(async () => ({ rows: [] }));
    assert.deepEqual(await listDevicesNeedingReview({ query }), []);
    assert.equal(query.mock.callCount(), 1);
  });

  test('buildRunSummary adds the flagged-device count to the run result', async () => {
    const query = mock.fn(async (sql) => (/FROM update_log/.test(sql)
      ? { rows: [{ status: 'success', count: 5 }, { status: 'blocked', count: 2 }] }
      : { rows: [{ count: 1 }] }));

    assert.deepEqual(await buildRunSummary({ query }, RUN_AT), {
      source: 'price-updater', event: 'run-summary', runAt: RUN_AT, successful: true, rows: 7,
      byStatus: { success: 5, blocked: 2 }, devicesNeedingReview: 1,
    });
  });
});

describe('setManualPrice', () => {
  const VERIFIED = new Date('2026-11-24T09:00:00Z');

  function fakeClient({ devices, distributor = { distributor_id: 3, name: 'PC Express' }, before = [], flagged = [] } = {}) {
    const statements = [];
    const query = mock.fn(async (sql, params) => {
      statements.push([sql, params]);
      if (/FROM device AS d/.test(sql)) return { rows: devices };
      if (/FROM distributor/.test(sql)) return { rows: distributor ? [distributor] : [] };
      if (/SELECT source_id FROM pricing/.test(sql)) return { rows: before };
      if (/WITH decision AS/.test(sql)) return { rows: flagged.map((id) => ({ device_id: id, needs_review: true })) };
      return { rows: [], rowCount: 1 };
    });
    return { client: { query }, statements };
  }
  const omada = [
    { device_id: 11, sku: 'ER605', name: 'Router', vendor_id: 1, vendor: 'TP-Link Omada' },
    { device_id: 12, sku: 'EAP610', name: 'AP', vendor_id: 1, vendor: 'TP-Link Omada' },
  ];
  const input = { vendor: 'tp-link omada', sku: ' er605 ', distributorId: 3, price: '₱3,450' };

  test('stores a manual row with stale, failure and review state cleared (AC7)', async () => {
    const { client, statements } = fakeClient({ devices: omada, before: [{ source_id: 9 }] });
    const refreshMedians = mock.fn(async () => ({ updated: [{ deviceId: 11, price: '3500.00', prices: 2 }], unchanged: [] }));

    const result = await setManualPrice(client, input, { refreshMedians, now: () => VERIFIED });

    const upsert = statements.find(([sql]) => /INSERT INTO pricing/.test(sql));
    assert.match(upsert[0], /VALUES \(\$1, \$2, NULL, \$3, \$4, FALSE, 0, FALSE\)/);
    assert.match(upsert[0], /ON CONFLICT \(device_id, distributor_id\) DO UPDATE[\s\S]*source_id = NULL[\s\S]*is_stale = FALSE[\s\S]*consecutive_failure_count = 0[\s\S]*needs_manual_review = FALSE/);
    assert.doesNotMatch(upsert[0].split('VALUES')[0], /pricing_id/);
    assert.deepEqual(upsert[1], [11, 3, '3450.00', VERIFIED]);
    assert.deepEqual(refreshMedians.mock.calls[0].arguments[1], [11]);
    assert.deepEqual(result, {
      deviceId: 11, vendor: 'TP-Link Omada', sku: 'ER605', name: 'Router', distributorId: 3, distributor: 'PC Express',
      price: '3450.00', replaced: 'synchronized', stillNeedsReview: false, medianRefreshed: true, devicePrice: '3500.00',
    });
  });

  test('re-evaluates the device\'s review flag after the update', async () => {
    const { client, statements } = fakeClient({ devices: omada, flagged: [] });

    const result = await setManualPrice(client, input, { now: () => VERIFIED });

    const order = statements.map(([sql]) => sql).findIndex((sql) => /WITH decision AS/.test(sql));
    const upsertAt = statements.map(([sql]) => sql).findIndex((sql) => /INSERT INTO pricing/.test(sql));
    assert.ok(order > upsertAt);
    assert.equal(result.stillNeedsReview, false);   // a manual price clears the flag, even with other distributors failing
    assert.equal(result.replaced, 'inserted');
    assert.equal(result.medianRefreshed, false);   // no refreshMedians passed in this test
  });

  test('rejects an unusable price, an unknown device or distributor, and missing arguments', async () => {
    const reject = async (overrides, clientOptions, pattern) => {
      const { client } = fakeClient({ devices: omada, ...clientOptions });
      await assert.rejects(setManualPrice(client, { ...input, ...overrides }), (error) => {
        assert.ok(error instanceof ManualPriceError);
        assert.match(error.message, pattern);
        return true;
      });
    };
    await reject({ price: '3,450 - 3,600' }, {}, /--price is not usable: Price is a range/);
    await reject({ price: 'USD 60' }, {}, /not in Philippine pesos/);
    await reject({ sku: 'ER7206' }, {}, /no device with SKU "ER7206"/);
    await reject({}, { devices: [] }, /No vendor named/);
    await reject({}, { distributor: null }, /No distributor with id 3/);
    await reject({ vendor: '' }, {}, /--vendor is required/);
    await reject({ distributorId: 0 }, {}, /--distributor must be/);
  });

  test('never writes when the input is rejected', async () => {
    const { client, statements } = fakeClient({ devices: omada });
    await assert.rejects(setManualPrice(client, { ...input, price: 'Call for price' }), ManualPriceError);
    assert.equal(statements.length, 0);
  });
});