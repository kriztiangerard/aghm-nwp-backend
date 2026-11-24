'use strict';

// NWP-PRICE-011: the workflow's plan, markBatchFailed and finalize actions. No database: pg is a fake.
// The SQL was also run on PostgreSQL 16 (see the NWP-PRICE-011 writeup).

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  groupIntoBatches, planRun, describeBatchError, markBatchFailed, readStop, finalizeRun, InvalidWorkflowInputError,
} = require('../../src/pricing/workflow');
const { createHandler } = require('../../src/pricing/handler');

const RUN_AT = '2026-11-29T18:00:00.000Z';   // Sunday 02:00 Asia/Manila
const src = (sourceId, vendorId, distributorId) => ({ sourceId, sourceUrl: `https://store/${sourceId}`, vendorId, distributorId });

describe('plan', () => {
  test('groups sources into one batch per vendor and distributor, sharing runAt (AC4)', () => {
    const batches = groupIntoBatches([src(7, 2, 1), src(3, 1, 5), src(4, 1, 5), src(1, 1, 2)], RUN_AT);

    assert.deepEqual(batches, [
      { runAt: RUN_AT, vendorId: 1, distributorId: 2, sources: [{ sourceId: 1, sourceUrl: 'https://store/1' }] },
      { runAt: RUN_AT, vendorId: 1, distributorId: 5, sources: [
        { sourceId: 3, sourceUrl: 'https://store/3' }, { sourceId: 4, sourceUrl: 'https://store/4' }] },
      { runAt: RUN_AT, vendorId: 2, distributorId: 1, sources: [{ sourceId: 7, sourceUrl: 'https://store/7' }] },
    ]);
  });

  test('reads the active sources and returns counts', async () => {
    const query = mock.fn(async () => ({ rows: [
      { source_id: 3, source_url: ' https://store/3 ', vendor_id: 1, distributor_id: 5 },
      { source_id: 4, source_url: 'https://store/4', vendor_id: 1, distributor_id: 5 },
    ] }));

    const result = await planRun({ query }, { runAt: RUN_AT });

    assert.equal(result.runAt, RUN_AT);
    assert.equal(result.batchCount, 1);
    assert.equal(result.sourceCount, 2);
    assert.equal(result.batches[0].sources[0].sourceUrl, 'https://store/3');
    assert.match(query.mock.calls[0].arguments[0], /WHERE is_active/);
  });

  test('no sources: no batches', async () => {
    const result = await planRun({ query: async () => ({ rows: [] }) }, { runAt: RUN_AT });
    assert.deepEqual(result, { runAt: RUN_AT, batchCount: 0, sourceCount: 0, batches: [] });
  });

  test('needs a runAt', async () => {
    await assert.rejects(planRun({ query: mock.fn() }, {}), InvalidWorkflowInputError);
    await assert.rejects(planRun({ query: mock.fn() }, { runAt: 'last sunday' }), InvalidWorkflowInputError);
  });
});

describe('markBatchFailed (AC5)', () => {
  const batch = { runAt: RUN_AT, vendorId: 1, distributorId: 5, sources: [{ sourceId: 3 }, { sourceId: 4 }] };
  const timeout = { Error: 'States.Timeout', Cause: 'Task timed out after 900.00 seconds' };

  function fakeClient(rows) {
    const inserts = [];
    const query = mock.fn(async (sql, params) => {
      if (/FROM pricing AS p/.test(sql)) return { rows };
      if (/INSERT INTO update_log/.test(sql)) { inserts.push(params); return { rowCount: 1 }; }
      throw new Error(`unexpected sql ${sql}`);
    });
    return { client: { query }, inserts, query };
  }

  test('records the batch\'s attributed devices as unexpected_error and marks them failed', async () => {
    const { client, inserts, query } = fakeClient([
      { device_id: 11, stored_this_run: false, recorded: false },
      { device_id: 12, stored_this_run: false, recorded: false },
    ]);
    const markSyncFailure = mock.fn(async () => ({ updated: true }));

    const result = await markBatchFailed(client, { batch, error: timeout }, { markSyncFailure });

    assert.deepEqual(result, { vendorId: 1, distributorId: 5, recorded: 2, byStatus: { unexpected_error: 2 }, alreadyRecorded: false });
    assert.deepEqual(inserts.map((p) => [p[0], p[1], p[2], p[4]]), [[5, 11, 'unexpected_error', RUN_AT], [5, 12, 'unexpected_error', RUN_AT]]);
    assert.equal(inserts[0][3], 'Batch failed as a whole (States.Timeout): Task timed out after 900.00 seconds');
    assert.deepEqual(markSyncFailure.mock.calls.map((c) => c.arguments[1]), [{ deviceId: 11, distributorId: 5 }, { deviceId: 12, distributorId: 5 }]);

    const [sql, params] = query.mock.calls[0].arguments;
    assert.match(sql, /p\.source_id = ANY\(\$3::int\[\]\)/);   // same attribution as NWP-PRICE-004
    assert.match(sql, /d\.vendor_id = \$2/);
    assert.deepEqual(params, [5, 1, [3, 4], RUN_AT]);
  });

  test('a price already stored in this run is recorded as success and not marked failed', async () => {
    const { client, inserts } = fakeClient([{ device_id: 11, stored_this_run: true, recorded: false }]);
    const markSyncFailure = mock.fn();

    const result = await markBatchFailed(client, { batch, error: timeout }, { markSyncFailure });

    assert.deepEqual(result.byStatus, { success: 1 });
    assert.deepEqual(inserts[0], [5, 11, 'success', null, RUN_AT]);
    assert.equal(markSyncFailure.mock.callCount(), 0);
  });

  test('devices already recorded in this run are left alone (safe to run twice)', async () => {
    const { client, inserts } = fakeClient([{ device_id: 11, stored_this_run: false, recorded: true }]);
    const markSyncFailure = mock.fn();

    const result = await markBatchFailed(client, { batch, error: timeout }, { markSyncFailure });

    assert.equal(result.alreadyRecorded, true);
    assert.equal(result.recorded, 0);
    assert.equal(inserts.length, 0);
    assert.equal(markSyncFailure.mock.callCount(), 0);
  });

  test('a batch with no sources records nothing; bad input throws', async () => {
    const query = mock.fn();
    assert.equal((await markBatchFailed({ query }, { batch: { ...batch, sources: [] } })).recorded, 0);
    assert.equal(query.mock.callCount(), 0);
    await assert.rejects(markBatchFailed({ query }, {}), InvalidWorkflowInputError);
    await assert.rejects(markBatchFailed({ query }, { batch: { ...batch, vendorId: '1' } }), InvalidWorkflowInputError);
  });

  test('error text: a Lambda error\'s message, plain causes, and a length limit', () => {
    const lambdaCause = JSON.stringify({ errorType: 'Error', errorMessage: 'connect ETIMEDOUT', trace: [] });
    assert.equal(describeBatchError({ Error: 'Error', Cause: lambdaCause }), 'Batch failed as a whole (Error): connect ETIMEDOUT');
    assert.equal(describeBatchError({ Error: 'Lambda.Unknown' }), 'Batch failed as a whole (Lambda.Unknown)');
    assert.equal(describeBatchError(undefined), 'Batch failed as a whole (UnknownError)');
    assert.equal(describeBatchError({ Error: 'X', Cause: 'y'.repeat(2000) }).length, 500);
  });
});

describe('finalize (AC6, AC7)', () => {
  function fakeClient({ devices = [11, 12], pricing = [], updateLog = [], flagged = 0 } = {}) {
    const statements = [];
    const query = mock.fn(async (sql, params) => {
      statements.push(sql);
      if (/SELECT DISTINCT device_id FROM update_log/.test(sql)) return { rows: devices.map((device_id) => ({ device_id })) };
      if (/FROM pricing\s+WHERE device_id = ANY/.test(sql)) return { rows: pricing };
      if (/UPDATE device SET price/.test(sql)) return { rowCount: 1 };
      if (/WITH decision AS/.test(sql)) return { rows: [] };
      if (/FROM update_log\s+WHERE run_at/.test(sql)) return { rows: updateLog };
      if (/COUNT\(DISTINCT device_id\)/.test(sql)) return { rows: [{ count: flagged }] };
      throw new Error(`unexpected sql ${sql}`);
    });
    return { client: { query }, statements };
  }

  test('refreshes medians, evaluates manual review, then records the run result and logs one line', async () => {
    const { client, statements } = fakeClient({
      pricing: [{ device_id: 11, price: '3400', source_id: 1, is_stale: false }, { device_id: 11, price: '3600', source_id: 2, is_stale: false }],
      updateLog: [{ status: 'success', count: 2 }, { status: 'blocked', count: 1 }],
      flagged: 1,
    });
    const logger = { log: mock.fn() };

    const line = await finalizeRun(client, { runAt: RUN_AT, stop: null }, { logger });

    assert.deepEqual(line, {
      source: 'price-updater', event: 'run-summary', runAt: RUN_AT, successful: true, rows: 3,
      byStatus: { success: 2, blocked: 1 }, devicesNeedingReview: 1,
      devices: 2, mediansUpdated: 1, mediansUnchanged: 1, flaggedInRun: 0, stoppedBy: null,
    });
    assert.deepEqual(JSON.parse(logger.log.mock.calls[0].arguments[0]), line);
    const order = ['update_log WHERE run_at = \\$1 ORDER', 'UPDATE device', 'WITH decision', 'GROUP BY status']
      .map((pattern) => statements.findIndex((sql) => new RegExp(pattern).test(sql)));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `statement order ${order}`);
  });

  test('passes includeStale and uses runAt as price_updated_at', async () => {
    const updates = [];
    const { client } = fakeClient({
      devices: [11],
      pricing: [{ device_id: 11, price: '3400', source_id: 1, is_stale: false }, { device_id: 11, price: '3800', source_id: 2, is_stale: true }],
    });
    const query = client.query;
    client.query = async (sql, params) => { if (/UPDATE device/.test(sql)) updates.push(params); return query(sql, params); };

    await finalizeRun(client, { runAt: RUN_AT }, { includeStale: true, logger: { log() {} } });

    assert.deepEqual(updates, [[11, '3600.00', new Date(RUN_AT)]]);
  });

  test('reports an account-level stop (AC6)', async () => {
    const { client } = fakeClient({ devices: [], updateLog: [] });
    const stop = { Error: 'PriceSync.AccountLevelStop', Cause: JSON.stringify({ status: 'quota_exceeded', sourceId: 3, message: 'credits used up' }) };

    const line = await finalizeRun(client, { runAt: RUN_AT, stop }, { logger: { log() {} } });

    assert.deepEqual(line.stoppedBy, { status: 'quota_exceeded', sourceId: 3, message: 'credits used up' });
    assert.equal(line.successful, false);
  });

  test('readStop keeps a cause that is not JSON', () => {
    assert.equal(readStop(null), null);
    assert.deepEqual(readStop({ Error: 'PriceSync.AccountLevelStop', Cause: 'oops' }), { status: 'PriceSync.AccountLevelStop', message: 'oops' });
  });

  test('needs a runAt', async () => {
    await assert.rejects(finalizeRun({ query: mock.fn() }, {}), InvalidWorkflowInputError);
  });
});

describe('handler wiring', () => {
  test('finalize reads PRICE_MEDIAN_INCLUDE_STALE from the settings', async () => {
    // The real actions open a transaction; here only the routing and settings are checked.
    const finalize = mock.fn(async (event, { config }) => ({ includeStale: config.medianIncludeStale }));
    const handler = createHandler({ actions: { finalize }, env: { PRICE_MEDIAN_INCLUDE_STALE: 'true' }, logger: { log() {}, error() {} } });
    assert.deepEqual(await handler({ action: 'finalize', runAt: RUN_AT }), { includeStale: true });
  });
});
