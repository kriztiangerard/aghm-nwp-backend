'use strict';

// NWP-PRICE-008: median price aggregation. No database: pg is replaced with a fake.
// The SQL was also run on PostgreSQL 16 (see the NWP-PRICE-008 writeup).

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeMedian, decimalToCentavos, centavosToDecimal, medianForRows, refreshDeviceMedians,
} = require('../../src/pricing/median');
const { loadPricingConfig } = require('../../src/pricing/config');
const { derivePriceProvenance } = require('../../src/types/engine/price-provenance');

const RUN_AT = new Date('2026-11-23T02:00:00.000Z');
const sync = (price, isStale = false) => ({ price, source_id: 1, is_stale: isStale });
const manual = (price) => ({ price, source_id: null, is_stale: false });

describe('computeMedian', () => {
  test('odd count: the middle value', () => {
    assert.equal(computeMedian([350000]), 350000);
    assert.equal(computeMedian([360000, 340000, 350000]), 350000);   // order doesn't matter
  });

  test('even count: mean of the two middle values (AC4)', () => {
    assert.equal(computeMedian([340000, 360000]), 350000);
    assert.equal(computeMedian([100000, 340000, 360000, 900000]), 350000);
  });

  test('even count: a half centavo rounds up (AC4)', () => {
    assert.equal(computeMedian([345000, 345001]), 345001);   // 3450.005 -> 3450.01
    assert.equal(computeMedian([1, 2]), 2);
    assert.equal(computeMedian([0, 1]), 1);
  });

  test('one unusual price does not move it', () => {
    assert.equal(computeMedian([350000, 352000, 99900]), 350000);   // a ₱999 scraping error
  });

  test('is integer arithmetic: no floating-point drift on large or awkward amounts', () => {
    assert.equal(computeMedian([10, 20]), 15);
    assert.equal(computeMedian([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 1]), Number.MAX_SAFE_INTEGER - 1);
    for (const value of [computeMedian([33, 34]), computeMedian([7, 8, 9, 10])]) assert.ok(Number.isInteger(value));
  });

  test('empty list is null; bad input throws', () => {
    assert.equal(computeMedian([]), null);
    assert.throws(() => computeMedian([1.5]), TypeError);
    assert.throws(() => computeMedian([-1]), TypeError);
    assert.throws(() => computeMedian('1,2'), TypeError);
  });
});

describe('decimal conversion', () => {
  test('DECIMAL strings to centavos, exactly', () => {
    assert.equal(decimalToCentavos('3500'), 350000);
    assert.equal(decimalToCentavos('3500.5'), 350050);
    assert.equal(decimalToCentavos('3500.50'), 350050);
    assert.equal(decimalToCentavos('0.07'), 7);
    assert.equal(decimalToCentavos(3500), 350000);
    assert.equal(decimalToCentavos('3500.005'), 350001);   // more than two decimals: half-up
    assert.equal(decimalToCentavos('3500.004'), 350000);
    assert.throws(() => decimalToCentavos('-1'), TypeError);
    assert.throws(() => decimalToCentavos('₱3,500'), TypeError);
    assert.throws(() => decimalToCentavos(null), TypeError);
  });

  test('centavos to a two-decimal string', () => {
    assert.equal(centavosToDecimal(345050), '3450.50');
    assert.equal(centavosToDecimal(7), '0.07');
    assert.equal(centavosToDecimal(350000), '3500.00');
  });
});

describe('medianForRows', () => {
  test('uses fresh rows only by default: non-stale synchronized and manual (AC1, AC6)', () => {
    const rows = [sync('3400'), sync('9999', true), manual('3600')];
    assert.deepEqual(medianForRows(rows), { centavos: 350000, used: 2, fresh: 2 });
  });

  test('includeStale adds stale synchronized rows when a fresh row exists (AC2)', () => {
    const rows = [sync('3400'), sync('3600', true), sync('3800', true)];
    assert.deepEqual(medianForRows(rows, { includeStale: true }), { centavos: 360000, used: 3, fresh: 1 });
    assert.deepEqual(medianForRows(rows, { includeStale: false }), { centavos: 340000, used: 1, fresh: 1 });
  });

  test('no fresh rows: no median, whatever the option (AC3)', () => {
    const rows = [sync('3400', true), sync('3600', true)];
    assert.equal(medianForRows(rows).centavos, null);
    assert.equal(medianForRows(rows, { includeStale: true }).centavos, null);
  });

  test('no rows: no median (AC5)', () => {
    assert.equal(medianForRows([]).centavos, null);
  });

  test('a manual row counts as fresh even if it says stale', () => {
    assert.equal(medianForRows([{ price: '3500', source_id: null, is_stale: true }]).centavos, 350000);
  });
});

describe('refreshDeviceMedians', () => {
  function fakeClient(pricingRows) {
    const updates = [];
    const query = mock.fn(async (sql, params) => {
      if (/FROM pricing/.test(sql)) return { rows: pricingRows };
      if (/UPDATE device/.test(sql)) { updates.push(params); return { rowCount: 1 }; }
      throw new Error(`unexpected sql ${sql}`);
    });
    return { client: { query }, updates, query };
  }

  test('sets device.price to the median and price_updated_at to the run time (AC1)', async () => {
    const { client, updates, query } = fakeClient([
      { device_id: 11, ...sync('3400.00') }, { device_id: 11, ...sync('3600.00') }, { device_id: 11, ...manual('3550') },
    ]);

    const result = await refreshDeviceMedians(client, [11], { updatedAt: RUN_AT });

    assert.deepEqual(updates, [[11, '3550.00', RUN_AT]]);
    assert.deepEqual(result, { updated: [{ deviceId: 11, price: '3550.00', prices: 3 }], unchanged: [] });
    assert.deepEqual(query.mock.calls[0].arguments[1], [[11]]);
    assert.match(query.mock.calls[1].arguments[0], /UPDATE device SET price = \$2, price_updated_at = \$3 WHERE device_id = \$1/);
  });

  test('leaves devices with no fresh rows, or no rows, untouched (AC3, AC5)', async () => {
    const { client, updates } = fakeClient([
      { device_id: 11, ...sync('3400', true) },
      { device_id: 13, ...sync('2100') },
    ]);

    const result = await refreshDeviceMedians(client, [12, 11, 13, 11], { updatedAt: RUN_AT });

    assert.deepEqual(updates, [[13, '2100.00', RUN_AT]]);
    assert.deepEqual(result.unchanged, [11, 12]);   // 11: only stale; 12: no rows at all
  });

  test('passes includeStale through (AC2)', async () => {
    const rows = [{ device_id: 11, ...sync('3400') }, { device_id: 11, ...sync('3600', true) }];
    const withStale = fakeClient(rows);
    await refreshDeviceMedians(withStale.client, [11], { includeStale: true, updatedAt: RUN_AT });
    assert.deepEqual(withStale.updates, [[11, '3500.00', RUN_AT]]);
  });

  test('does nothing for no devices, and validates its input', async () => {
    const query = mock.fn();
    assert.deepEqual(await refreshDeviceMedians({ query }, []), { updated: [], unchanged: [] });
    await assert.rejects(refreshDeviceMedians({ query }, ['11']), TypeError);
    await assert.rejects(refreshDeviceMedians({ query }, [11], { includeStale: 'false' }), TypeError);
    assert.equal(query.mock.callCount(), 0);
  });
});

describe('configuration', () => {
  test('PRICE_MEDIAN_INCLUDE_STALE defaults to false', () => {
    assert.equal(loadPricingConfig({}).medianIncludeStale, false);
    assert.equal(loadPricingConfig({ PRICE_MEDIAN_INCLUDE_STALE: 'true' }).medianIncludeStale, true);
  });
});

describe('price provenance (NWP-ENGINE-006), confirmation', () => {
  test('a device with a manual row and synchronized rows reports "manual" and the median written here', () => {
    const rows = [sync('3400'), sync('3600'), manual('3550')];
    const { centavos } = medianForRows(rows);
    const device = { price: centavosToDecimal(centavos), price_updated_at: RUN_AT };

    assert.deepEqual(derivePriceProvenance(rows, device), {
      price_source: 'manual', is_stale: false, price_updated_at: '2026-11-23T02:00:00.000Z',
    });
    assert.equal(device.price, '3550.00');
  });

  test('all synchronized rows report "synchronized"', () => {
    const rows = [sync('3400'), sync('3600')];
    assert.equal(derivePriceProvenance(rows, { price: '3500.00', price_updated_at: RUN_AT }).price_source, 'synchronized');
  });
});