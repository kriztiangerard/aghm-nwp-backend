'use strict';

// NWP-PRICE-005: markSyncFailure / markSyncSuccess, and that the 002/004 steps use them by default.
// No database: pg is replaced with a recording fake. The SQL itself was also checked on PostgreSQL 16
// (see docs/NWP-PRICE-005 writeup).

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { markSyncFailure, markSyncSuccess } = require('../../src/pricing/pricing-state');
const { processSourceBatch } = require('../../src/pricing/collect');
const { recordBatchOutcome } = require('../../src/pricing/outcome');
const { buildSkuIndex } = require('../../src/pricing/normalize-record');
const { derivePriceProvenance } = require('../../src/types/engine/price-provenance');

const PAIR = { deviceId: 11, distributorId: 7 };

function recordingClient(rowCount = 1) {
  const rows = rowCount > 0 ? [{ consecutive_failure_count: 2 }] : [];
  return { query: mock.fn(async () => ({ rowCount, rows })) };
}

describe('markSyncFailure', () => {
  test('marks only the synchronized row of that pair stale and counts the failure (005 AC1, AC5; 006 AC1)', async () => {
    const client = recordingClient(1);

    assert.deepEqual(await markSyncFailure(client, PAIR), { updated: true, consecutiveFailures: 2 });

    const [sql, params] = client.query.mock.calls[0].arguments;
    assert.match(sql, /^\s*UPDATE pricing\s+SET is_stale = TRUE,\s+consecutive_failure_count = consecutive_failure_count \+ 1\s+WHERE device_id = \$1\s+AND distributor_id = \$2\s+AND source_id IS NOT NULL\s+RETURNING consecutive_failure_count\s*$/);
    assert.deepEqual(params, [11, 7]);
  });

  test('never changes the price, source or retrieval time, and never inserts or deletes (AC1, AC4)', async () => {
    const client = recordingClient(1);
    await markSyncFailure(client, PAIR);
    const sql = client.query.mock.calls[0].arguments[0];
    const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));
    assert.doesNotMatch(setClause.replace('consecutive_failure_count', ''), /price|source_id|last_updated/);
    assert.doesNotMatch(sql, /INSERT|DELETE|ON CONFLICT/);
  });

  test('reports when there was nothing to mark (no row, or a manual row)', async () => {
    assert.deepEqual(await markSyncFailure(recordingClient(0), PAIR), { updated: false, consecutiveFailures: null });
  });

  test('rejects a malformed pair before querying', async () => {
    const client = recordingClient();
    await assert.rejects(markSyncFailure(client, { deviceId: '11', distributorId: 7 }), TypeError);
    await assert.rejects(markSyncFailure(client, null), TypeError);
    assert.equal(client.query.mock.callCount(), 0);
  });
});

describe('markSyncSuccess', () => {
  test('clears the stale flag and resets the failure count of that pair only (005 AC3; 006 AC4)', async () => {
    const client = recordingClient(1);

    assert.deepEqual(await markSyncSuccess(client, PAIR), { updated: true });

    const [sql, params] = client.query.mock.calls[0].arguments;
    assert.match(sql, /UPDATE pricing\s+SET is_stale = FALSE,\s+consecutive_failure_count = 0\s+WHERE device_id = \$1\s+AND distributor_id = \$2/);
    assert.doesNotMatch(sql, /INSERT|DELETE/);
    assert.deepEqual(params, [11, 7]);
  });

  test('rejects a malformed pair before querying', async () => {
    const client = recordingClient();
    await assert.rejects(markSyncSuccess(client, { deviceId: 11 }), TypeError);
    assert.equal(client.query.mock.callCount(), 0);
  });
});

describe('used by default in the sync', () => {
  test('processSourceBatch clears is_stale in the same transaction as the upsert (002 + 005)', async () => {
    const statements = [];
    const client = {
      query: async (sql) => {
        statements.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40));
        return /^\s*INSERT INTO pricing/.test(sql) ? { rows: [{ pricing_id: 1, inserted: false }] } : { rowCount: 1, rows: [] };
      },
    };
    const transactions = [];
    const withTransaction = async (work) => { transactions.push('begin'); const r = await work(client); transactions.push('commit'); return r; };

    await processSourceBatch(
      { runAt: '2026-11-23T02:00:00.000Z', vendorId: 1, distributorId: 7, sources: [{ sourceId: 101, sourceUrl: 'https://s/1' }] },
      {
        scrape: async () => ({ ok: true, json: { products: [{ sku: 'ER605', price: '₱3,500.00' }] } }),
        loadSkuIndex: async () => buildSkuIndex([{ deviceId: 11, sku: 'ER605' }]),
        withTransaction,
        sleep: async () => {},
        logger: { log() {} },
      },
    );

    assert.deepEqual(transactions, ['begin', 'commit']);
    assert.equal(statements.length, 2);
    assert.match(statements[0], /^INSERT INTO pricing/);
    assert.match(statements[1], /^UPDATE pricing SET is_stale = FALSE/);
  });

  test('recordBatchOutcome marks failed rows stale and leaves successes alone (004 + 005)', async () => {
    const updates = [];
    const client = {
      query: async (sql, params) => {
        if (/FROM pricing AS p/.test(sql)) return { rows: [{ device_id: 11, source_id: 101 }, { device_id: 12, source_id: 102 }] };
        if (/^\s*UPDATE pricing/.test(sql)) { updates.push([sql.includes('is_stale = TRUE'), ...params]); return { rowCount: 1 }; }
        return { rows: [] };
      },
    };

    await recordBatchOutcome(client, {
      runAt: '2026-11-23T02:00:00.000Z', vendorId: 1, distributorId: 7,
      pages: [{ sourceId: 101, status: 'success' }, { sourceId: 102, status: 'blocked', message: 'captcha' }],
      found: [11], rejected: [], dbErrors: [], stoppedBy: null,
    });

    assert.deepEqual(updates, [[true, 12, 7]]);   // only the blocked page's device
  });
});

describe('engine reads staleness per device (AC2, confirmation)', () => {
  const device = { price: 3500, price_updated_at: '2026-11-16T02:00:00.000Z' };

  test('stale only when every pricing row is stale; the price is kept', () => {
    assert.equal(derivePriceProvenance([{ source_id: 1, is_stale: true }, { source_id: 2, is_stale: true }], device).is_stale, true);
    assert.equal(derivePriceProvenance([{ source_id: 1, is_stale: true }, { source_id: 2, is_stale: false }], device).is_stale, false);
    assert.equal(derivePriceProvenance([{ source_id: 1, is_stale: true }, { source_id: null, is_stale: false }], device).is_stale, false);
  });
});