'use strict';

// NWP-PRICE-010: Price updater handler, settings, outbound probe and transaction helper.
// Runs with node:test; no network, AWS or database.

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  createHandler, ACTIONS, UnknownActionError, NotImplementedError,
} = require('../../src/pricing/handler');
const { loadPricingConfig, DEFAULTS } = require('../../src/pricing/config');
const { probeOutbound, ProbeFailedError, DEFAULT_PROBE_URL, probeDatabase, DatabaseUnavailableError } = require('../../src/pricing/probe');
const { withTransaction } = require('../../src/pricing/db');

function silentLogger() {
  return { log: mock.fn(), error: mock.fn() };
}

describe('handler: action routing', () => {
  test('routes to the named action and passes the event and settings', async () => {
    const probe = mock.fn(async () => ({ ok: true }));
    const handler = createHandler({ actions: { probe }, env: { FIRECRAWL_CONCURRENCY: '3' }, logger: silentLogger() });

    const result = await handler({ action: 'probe', extra: 1 });

    assert.deepEqual(result, { ok: true });
    assert.equal(probe.mock.callCount(), 1);
    const [event, context] = probe.mock.calls[0].arguments;
    assert.deepEqual(event, { action: 'probe', extra: 1 });
    assert.equal(context.config.firecrawlConcurrency, 3);
  });

  test('knows the five actions of the sync workflow', () => {
    assert.deepEqual(Object.values(ACTIONS).sort(), ['finalize', 'markBatchFailed', 'plan', 'probe', 'process']);
  });

  test('an unknown, missing or non-string action is rejected with the list of actions', async () => {
    const handler = createHandler({ logger: silentLogger() });

    for (const event of [{ action: 'scrape' }, {}, null, undefined, { action: 42 }, { action: 'toString' }]) {
      await assert.rejects(handler(event), (error) => {
        assert.ok(error instanceof UnknownActionError);
        assert.match(error.message, /probe, plan, process, markBatchFailed, finalize/);
        return true;
      });
    }
  });

  test('actions from later stories say which story builds them', async () => {
    const handler = createHandler({ logger: silentLogger() });

    const expected = { plan: 'NWP-PRICE-011', markBatchFailed: 'NWP-PRICE-011', finalize: 'NWP-PRICE-011' };   // process: NWP-PRICE-002, built
    for (const [action, story] of Object.entries(expected)) {
      await assert.rejects(handler({ action }), (error) => {
        assert.ok(error instanceof NotImplementedError);
        assert.ok(error.message.includes(story), `${action}: ${error.message}`);
        return true;
      });
    }
  });

  test('a later story can replace an action', async () => {
    const plan = mock.fn(async () => ({ batches: [] }));
    const handler = createHandler({ actions: { plan }, logger: silentLogger() });

    assert.deepEqual(await handler({ action: 'plan' }), { batches: [] });
  });

  test('writes one structured log line on success', async () => {
    const logger = silentLogger();
    let clock = 1000;
    const handler = createHandler({
      actions: { probe: async () => { clock += 25; return {}; } }, logger, now: () => clock,
    });

    await handler({ action: 'probe' });

    assert.equal(logger.log.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(logger.log.mock.calls[0].arguments[0]), { source: 'price-updater', action: 'probe', ok: true, ms: 25 });
  });

  test('logs and re-throws a failing action, so Step Functions sees the error', async () => {
    const logger = silentLogger();
    const handler = createHandler({ actions: { probe: async () => { throw new ProbeFailedError('no route'); } }, logger });

    await assert.rejects(handler({ action: 'probe' }), ProbeFailedError);
    const line = JSON.parse(logger.error.mock.calls[0].arguments[0]);
    assert.equal(line.ok, false);
    assert.equal(line.error, 'ProbeFailedError');
    assert.equal(line.message, 'no route');
  });

  test('a malformed setting fails the invocation and is logged', async () => {
    const logger = silentLogger();
    const probe = mock.fn(async () => ({}));
    const handler = createHandler({ actions: { probe }, env: { PRICE_MEDIAN_INCLUDE_STALE: 'yes' }, logger });

    await assert.rejects(handler({ action: 'probe' }), /PRICE_MEDIAN_INCLUDE_STALE/);
    assert.equal(probe.mock.callCount(), 0);
    assert.equal(logger.error.mock.callCount(), 1);
  });
});

describe('loadPricingConfig', () => {
  test('uses the defaults when nothing is set', () => {
    assert.deepEqual({ ...loadPricingConfig({}) }, { firecrawlConcurrency: 2, medianIncludeStale: false });
    assert.equal(DEFAULTS.firecrawlConcurrency, 2);
  });

  test('reads the values the stack sets', () => {
    const config = loadPricingConfig({ FIRECRAWL_CONCURRENCY: ' 5 ', PRICE_MEDIAN_INCLUDE_STALE: 'TRUE' });

    assert.equal(config.firecrawlConcurrency, 5);
    assert.equal(config.medianIncludeStale, true);
    assert.equal(Object.isFrozen(config), true);
  });

  test('treats empty values as unset', () => {
    assert.deepEqual({ ...loadPricingConfig({ FIRECRAWL_CONCURRENCY: '', PRICE_MEDIAN_INCLUDE_STALE: ' ' }) },
      { firecrawlConcurrency: 2, medianIncludeStale: false });
  });

  test('rejects malformed values instead of guessing', () => {
    for (const value of ['0', '-1', '1.5', 'two', '1e3']) {
      assert.throws(() => loadPricingConfig({ FIRECRAWL_CONCURRENCY: value }), /FIRECRAWL_CONCURRENCY/, value);
    }
    for (const value of ['yes', '1', 'no', 'on']) {
      assert.throws(() => loadPricingConfig({ PRICE_MEDIAN_INCLUDE_STALE: value }), /PRICE_MEDIAN_INCLUDE_STALE/, value);
    }
  });
});

describe('probeOutbound', () => {
  test('any HTTP response counts as outbound access, and the key is not sent', async () => {
    const fetchImpl = mock.fn(async () => new Response('not found', { status: 404 }));
    let clock = 0;

    const result = await probeOutbound({ fetchImpl, now: () => (clock += 40) });

    assert.deepEqual(result, { ok: true, url: DEFAULT_PROBE_URL, httpStatus: 404, elapsedMs: 40 });
    const [url, init] = fetchImpl.mock.calls[0].arguments;
    assert.equal(url, 'https://api.firecrawl.dev/');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers, undefined);
  });

  test('a connection failure throws ProbeFailedError naming the cause', async () => {
    const fetchImpl = async () => {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ETIMEDOUT' };
      throw error;
    };

    await assert.rejects(probeOutbound({ fetchImpl }), (error) => {
      assert.equal(error.name, 'ProbeFailedError');
      assert.match(error.message, /ETIMEDOUT/);
      assert.match(error.message, /fck-nat/);
      return true;
    });
  });

  test('no answer within the timeout throws ProbeFailedError', async () => {
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

    await assert.rejects(probeOutbound({ fetchImpl, timeoutMs: 20 }), (error) => {
      assert.ok(error instanceof ProbeFailedError);
      assert.match(error.message, /no response within 20 ms/);
      return true;
    });
  });
});

describe('withTransaction', () => {
  function fakePool() {
    const queries = [];
    const client = { query: mock.fn(async (sql) => { queries.push(sql); }), release: mock.fn() };
    return { pool: { connect: async () => client }, client, queries };
  }

  test('commits when the work succeeds and returns its result', async () => {
    const { pool, client, queries } = fakePool();

    const result = await withTransaction(async (c) => { await c.query('UPDATE pricing SET is_stale = false'); return 7; }, { pool });

    assert.equal(result, 7);
    assert.deepEqual(queries, ['BEGIN', 'UPDATE pricing SET is_stale = false', 'COMMIT']);
    assert.equal(client.release.mock.callCount(), 1);
  });

  test('rolls back and re-throws when the work fails', async () => {
    const { pool, client, queries } = fakePool();

    await assert.rejects(withTransaction(async () => { throw new Error('duplicate key'); }, { pool }), /duplicate key/);
    assert.deepEqual(queries, ['BEGIN', 'ROLLBACK']);
    assert.equal(client.release.mock.callCount(), 1);
  });

  test('rejects a missing work function', async () => {
    await assert.rejects(withTransaction(null, { pool: fakePool().pool }), TypeError);
  });
});

describe('probeDatabase (AC1: reaches RDS)', () => {
  test('one query through the pool; reports the database name, nothing else', async () => {
    const query = mock.fn(async () => ({ rows: [{ name: 'nwp_qa' }] }));
    const result = await probeDatabase({ getPool: async () => ({ query }) });

    assert.deepEqual(result, { database: 'reachable', databaseName: 'nwp_qa' });
    assert.equal(query.mock.callCount(), 1);
    assert.match(query.mock.calls[0].arguments[0], /^SELECT current_database\(\)/);
  });

  test('a connection error becomes DatabaseUnavailableError', async () => {
    const getPool = async () => ({ query: async () => { throw new Error('connect ETIMEDOUT 10.0.1.5:5432'); } });
    await assert.rejects(probeDatabase({ getPool }), (error) => {
      assert.ok(error instanceof DatabaseUnavailableError);
      assert.match(error.message, /could not be reached: connect ETIMEDOUT/);
      return true;
    });
  });

  test('an unanswered query fails after the timeout instead of hanging', async () => {
    const getPool = async () => ({ query: () => new Promise(() => {}) });
    const started = Date.now();
    await assert.rejects(probeDatabase({ getPool, timeoutMs: 50 }), /no answer within 50 ms/);
    assert.ok(Date.now() - started < 1000);
  });

  test('a pool that cannot be created (for example the secret) is reported the same way', async () => {
    await assert.rejects(probeDatabase({ getPool: async () => { throw new Error('AccessDenied'); } }), DatabaseUnavailableError);
  });
});
