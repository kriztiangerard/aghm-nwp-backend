'use strict';

// NWP-PRICE-002: batch collection (collect.js), the price store, the source queries and the extraction schema.
// No network and no database: Firecrawl and pg are replaced with fakes.

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  processSourceBatch, combinePages, mapWithConcurrency, InvalidBatchError, PAGE_STATUS,
} = require('../../src/pricing/collect');
const { upsertSynchronizedPrice } = require('../../src/pricing/price-store');
const { listActiveSources, loadVendorSkuIndex } = require('../../src/pricing/sources');
const { LISTING_SCHEMA, readProducts } = require('../../src/pricing/extraction');
const { buildSkuIndex } = require('../../src/pricing/normalize-record');

const RUN_AT = '2026-11-23T02:00:00.000Z';
const RETRIEVED = new Date('2026-11-23T02:01:00.000Z');

// Vendor 1's catalog: ER605 -> 11, EAP610 -> 12, SG2008P -> 13.
const SKU_INDEX = buildSkuIndex([
  { deviceId: 11, sku: 'ER605' },
  { deviceId: 12, sku: 'EAP610' },
  { deviceId: 13, sku: 'SG2008P' },
]);

function batch(overrides = {}) {
  return {
    runAt: RUN_AT,
    vendorId: 1,
    distributorId: 7,
    sources: [
      { sourceId: 101, sourceUrl: 'https://store.example/omada?page=1' },
      { sourceId: 102, sourceUrl: 'https://store.example/omada?page=2' },
    ],
    ...overrides,
  };
}

/** Firecrawl stand-in: url -> result (an object, or products array as shorthand for a success). */
function fakeScrape(byUrl) {
  return mock.fn(async (url) => {
    const value = byUrl[url];
    if (Array.isArray(value)) return { ok: true, json: { products: value }, httpStatus: 200, creditsUsed: 5 };
    if (value) return value;
    throw new Error(`unexpected url ${url}`);
  });
}

/** Records every transaction and the calls made inside it. */
function fakeDb({ failOnDevice } = {}) {
  const transactions = [];
  const withTransaction = mock.fn(async (work) => {
    const calls = [];
    transactions.push(calls);
    const client = { calls };
    return work(client);
  });
  const upsertPrice = mock.fn(async (client, record) => {
    if (record.deviceId === failOnDevice) throw new Error('connection reset');
    client.calls.push(['upsert', record.deviceId]);
    return { pricingId: record.deviceId * 10, inserted: record.deviceId !== 12 };
  });
  const markSyncSuccess = mock.fn(async (client, ids) => { client.calls.push(['markSyncSuccess', ids.deviceId]); });
  return { transactions, withTransaction, upsertPrice, markSyncSuccess };
}

function deps(scrape, db, extra = {}) {
  return {
    scrape,
    loadSkuIndex: async () => SKU_INDEX,
    withTransaction: db.withTransaction,
    upsertPrice: db.upsertPrice,
    markSyncSuccess: db.markSyncSuccess,
    now: () => RETRIEVED,
    sleep: async () => {},
    logger: { log() {} },
    ...extra,
  };
}

describe('processSourceBatch', () => {
  test('scrapes every page of the batch with the listing schema (AC1, AC2)', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': [{ sku: 'ER605', price: '₱3,500.00' }],
      'https://store.example/omada?page=2': [{ sku: 'EAP610', price: '₱5,200.00' }],
    });
    const db = fakeDb();

    await processSourceBatch(batch(), deps(scrape, db));

    assert.equal(scrape.mock.callCount(), 2);
    assert.deepEqual(scrape.mock.calls.map((c) => c.arguments[0]).sort(),
      ['https://store.example/omada?page=1', 'https://store.example/omada?page=2']);
    for (const call of scrape.mock.calls) assert.equal(call.arguments[1].schema, LISTING_SCHEMA);
  });

  test('stores each found device with its price, source page and retrieval time (AC3)', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': [{ sku: 'ER605', price: '₱3,500.00' }],
      'https://store.example/omada?page=2': [{ sku: 'eap610', price: 'PHP 5,200' }],
    });
    const db = fakeDb();

    const summary = await processSourceBatch(batch(), deps(scrape, db));

    const stored = db.upsertPrice.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(stored.map((r) => [r.deviceId, r.distributorId, r.sourceId, r.price]), [
      [11, 7, 101, '3500.00'],
      [12, 7, 102, '5200.00'],
    ]);
    for (const record of stored) assert.deepEqual(record.retrievedAt, RETRIEVED);
    assert.deepEqual(summary.found, [11, 12]);
    assert.deepEqual(summary.stored, { inserted: 1, updated: 1 });
  });

  test('runs upsert and markSyncSuccess together, one transaction per device', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': [{ sku: 'ER605', price: '₱3,500.00' }, { sku: 'SG2008P', price: '₱2,100.00' }],
      'https://store.example/omada?page=2': [],
    });
    const db = fakeDb();

    await processSourceBatch(batch(), deps(scrape, db));

    assert.deepEqual(db.transactions, [
      [['upsert', 11], ['markSyncSuccess', 11]],
      [['upsert', 13], ['markSyncSuccess', 13]],
    ]);
    assert.deepEqual(db.markSyncSuccess.mock.calls[0].arguments[1], { deviceId: 11, distributorId: 7 });
  });

  test('skips products that are not in the vendor catalog, without a failure (AC5)', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': [
        { sku: 'ER605', price: '₱3,500.00' },
        { sku: 'DECO-X20', price: '₱10,800.00' },
        { sku: 'TAPO-C200', price: '₱1,200.00' },
      ],
      'https://store.example/omada?page=2': [{ sku: 'EAP610', price: '₱5,200.00' }],
    });

    const summary = await processSourceBatch(batch(), deps(scrape, fakeDb()));

    assert.deepEqual(summary.rejected, []);
    assert.deepEqual(summary.pages[0], {
      sourceId: 101, creditsUsed: 5, attempts: 1, status: PAGE_STATUS.SUCCESS, productCount: 3, matched: 1, unmatched: 2, rejectedWithoutDevice: 0,
    });
  });

  test('reports found and rejected devices for NWP-PRICE-004 (AC6)', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': [
        { sku: 'ER605', price: '₱3,500.00' },
        { sku: 'EAP610', price: 'Call for price' },
        { price: '₱99.00' },
      ],
      'https://store.example/omada?page=2': [{ sku: 'SG2008P' }],
    });
    const db = fakeDb();

    const summary = await processSourceBatch(batch(), deps(scrape, db));

    assert.equal(summary.runAt, RUN_AT);
    assert.equal(summary.vendorId, 1);
    assert.equal(summary.distributorId, 7);
    assert.deepEqual(summary.found, [11]);
    assert.deepEqual(summary.rejected.map((r) => [r.deviceId, r.reason]), [[12, 'invalid_price'], [13, 'missing_field']]);
    for (const r of summary.rejected) assert.equal(typeof r.detail, 'string');
    assert.equal(summary.pages[0].rejectedWithoutDevice, 1);   // the product with no SKU
    assert.equal(db.upsertPrice.mock.callCount(), 1);
  });

  test('a device listed on two pages at different prices is stored from neither', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': [{ sku: 'ER605', price: '₱3,500.00' }, { sku: 'EAP610', price: '₱5,200.00' }],
      'https://store.example/omada?page=2': [{ sku: 'ER605', price: '₱3,450.00' }],
    });
    const db = fakeDb();

    const summary = await processSourceBatch(batch(), deps(scrape, db));

    assert.deepEqual(summary.found, [12]);
    assert.equal(summary.rejected.length, 1);
    assert.equal(summary.rejected[0].deviceId, 11);
    assert.equal(summary.rejected[0].reason, 'invalid_price');
    assert.match(summary.rejected[0].detail, /3450\.00, 3500\.00/);
  });

  test('a device listed on two pages at the same price is stored once, from the first page', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': [{ sku: 'ER605', price: '₱3,500.00' }],
      'https://store.example/omada?page=2': [{ sku: 'ER605', price: 'PHP 3500' }],
    });
    const db = fakeDb();

    const summary = await processSourceBatch(batch(), deps(scrape, db));

    assert.deepEqual(summary.found, [11]);
    assert.equal(db.upsertPrice.mock.callCount(), 1);
    assert.equal(db.upsertPrice.mock.calls[0].arguments[1].sourceId, 101);
  });

  test('a price found on one page wins over a rejection of the same device on another page', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': [{ sku: 'ER605', price: 'from ₱3,500.00' }],
      'https://store.example/omada?page=2': [{ sku: 'ER605', price: '₱3,500.00' }],
    });

    const summary = await processSourceBatch(batch(), deps(scrape, fakeDb()));

    assert.deepEqual(summary.found, [11]);
    assert.deepEqual(summary.rejected, []);
  });

  test('a failed page is reported with its error type and the other pages still count', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': { ok: false, errorType: 'blocked', message: 'Target returned 403.' },
      'https://store.example/omada?page=2': [{ sku: 'EAP610', price: '₱5,200.00' }],
    });

    const summary = await processSourceBatch(batch(), deps(scrape, fakeDb()));

    assert.deepEqual(summary.pages[0], { sourceId: 101, status: 'blocked', productCount: 0, attempts: 1, message: 'Target returned 403.' });
    assert.equal(summary.pages[1].status, PAGE_STATUS.SUCCESS);
    assert.deepEqual(summary.found, [12]);
  });

  test('no products array is invalid_response; an empty list is empty_content', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': { ok: true, json: { items: [] }, httpStatus: 200 },
      'https://store.example/omada?page=2': [],
    });

    const summary = await processSourceBatch(batch(), deps(scrape, fakeDb()));

    assert.deepEqual(summary.pages.map((p) => [p.status, p.message]), [
      ['invalid_response', 'The extracted JSON has no products array.'],
      ['empty_content', 'The page listed no products.'],
    ]);
    assert.deepEqual(summary.found, []);
  });

  test('a vendor with no catalog devices is skipped without scraping', async () => {
    const scrape = fakeScrape({});
    const db = fakeDb();

    const summary = await processSourceBatch(batch(), deps(scrape, db, { loadSkuIndex: async () => new Map() }));

    assert.equal(scrape.mock.callCount(), 0);
    assert.deepEqual(summary.pages.map((p) => [p.sourceId, p.status]), [[101, 'skipped'], [102, 'skipped']]);
    assert.deepEqual(summary.found, []);
  });

  test('never has more pages in flight than the concurrency setting', async () => {
    let inFlight = 0;
    let peak = 0;
    const scrape = mock.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, json: { products: [] }, httpStatus: 200 };
    });
    const sources = Array.from({ length: 7 }, (_, i) => ({ sourceId: 200 + i, sourceUrl: `https://store.example/p${i}` }));

    const summary = await processSourceBatch(batch({ sources }), deps(scrape, fakeDb(), { concurrency: 2 }));

    assert.equal(scrape.mock.callCount(), 7);
    assert.equal(peak, 2);
    assert.deepEqual(summary.pages.map((p) => p.sourceId), sources.map((s) => s.sourceId));   // batch order kept
  });

  test('a database error rolls back only that device and is reported as a db error (004)', async () => {
    const scrape = fakeScrape({
      'https://store.example/omada?page=1': [{ sku: 'ER605', price: '₱3,500.00' }, { sku: 'EAP610', price: '₱5,200.00' }],
      'https://store.example/omada?page=2': [{ sku: 'SG2008P', price: '₱2,100.00' }],
    });
    const db = fakeDb({ failOnDevice: 12 });

    const summary = await processSourceBatch(batch(), deps(scrape, db));

    assert.deepEqual(summary.found, [11, 13]);
    assert.deepEqual(summary.dbErrors, [{ deviceId: 12, detail: 'Storing the price failed: connection reset' }]);
    assert.equal(db.markSyncSuccess.mock.callCount(), 2);   // not for the failed device
  });

  test('rejects a malformed batch before scraping', async () => {
    const scrape = fakeScrape({});
    const bad = [
      batch({ runAt: 'yesterday' }),
      batch({ vendorId: 0 }),
      batch({ sources: [] }),
      batch({ sources: [{ sourceId: 1, sourceUrl: '' }] }),
      batch({ sources: [{ sourceId: 1, sourceUrl: 'https://a' }, { sourceId: 1, sourceUrl: 'https://b' }] }),
    ];
    for (const input of bad) {
      await assert.rejects(processSourceBatch(input, deps(scrape, fakeDb())), InvalidBatchError);
    }
    assert.equal(scrape.mock.callCount(), 0);
  });
});

describe('combinePages', () => {
  test('ignores failed pages (null listings)', () => {
    const record = { deviceId: 11, sourceId: 101, priceCentavos: 350000 };
    const { toStore, rejected } = combinePages([null, { records: [record], rejected: [], unmatched: 0 }]);
    assert.deepEqual(toStore, [record]);
    assert.deepEqual(rejected, []);
  });
});

describe('mapWithConcurrency', () => {
  test('keeps input order and handles an empty list', async () => {
    assert.deepEqual(await mapWithConcurrency([3, 1, 2], 2, async (n) => n * 2), [6, 2, 4]);
    assert.deepEqual(await mapWithConcurrency([], 2, async () => 1), []);
  });
});

describe('upsertSynchronizedPrice', () => {
  const record = { deviceId: 11, distributorId: 7, sourceId: 101, price: '3500.00', retrievedAt: RETRIEVED };

  test('inserts or updates on (device_id, distributor_id) and never passes pricing_id (AC3, AC4)', async () => {
    const query = mock.fn(async () => ({ rows: [{ pricing_id: 55, inserted: false }] }));

    const result = await upsertSynchronizedPrice({ query }, record);

    assert.deepEqual(result, { pricingId: 55, inserted: false });
    const [sql, params] = query.mock.calls[0].arguments;
    assert.match(sql, /INSERT INTO pricing \(device_id, distributor_id, source_id, price, last_updated\)/);
    assert.match(sql, /ON CONFLICT \(device_id, distributor_id\) DO UPDATE/);
    assert.match(sql, /source_id\s+= EXCLUDED\.source_id/);   // replaces a manual row's NULL source_id
    assert.doesNotMatch(sql.split('VALUES')[0], /pricing_id/);   // the identity default assigns it
    assert.deepEqual(params, [11, 7, 101, '3500.00', RETRIEVED]);
  });

  test('rejects records that did not come from normalizeListing', async () => {
    const query = mock.fn();
    await assert.rejects(upsertSynchronizedPrice({ query }, { ...record, price: 3500 }), TypeError);
    await assert.rejects(upsertSynchronizedPrice({ query }, { ...record, sourceId: null }), TypeError);
    await assert.rejects(upsertSynchronizedPrice({ query }, { ...record, retrievedAt: 'now' }), TypeError);
    assert.equal(query.mock.callCount(), 0);
  });
});

describe('sources', () => {
  test('listActiveSources returns active sources with a URL, as numbers, in batch order', async () => {
    const query = mock.fn(async () => ({ rows: [{ source_id: '5', source_url: ' https://a ', vendor_id: '1', distributor_id: '7' }] }));

    const sources = await listActiveSources({ query });

    assert.deepEqual(sources, [{ sourceId: 5, sourceUrl: 'https://a', vendorId: 1, distributorId: 7 }]);
    const sql = query.mock.calls[0].arguments[0];
    assert.match(sql, /WHERE is_active/);
    assert.match(sql, /source_url IS NOT NULL/);
    assert.match(sql, /ORDER BY vendor_id, distributor_id, source_id/);
  });

  test('loadVendorSkuIndex builds the SKU index for one vendor', async () => {
    const query = mock.fn(async () => ({ rows: [{ device_id: 11, sku: 'ER605' }, { device_id: 12, sku: ' eap610 ' }] }));

    const index = await loadVendorSkuIndex({ query }, 1);

    assert.equal(index.get('ER605'), 11);
    assert.equal(index.get('EAP610'), 12);
    assert.deepEqual(query.mock.calls[0].arguments[1], [1]);
  });
});

describe('extraction', () => {
  test('the schema asks for a product list with sku and price', () => {
    assert.deepEqual(LISTING_SCHEMA.required, ['products']);
    assert.deepEqual(LISTING_SCHEMA.properties.products.items.required, ['sku', 'price']);
    assert.ok(Object.isFrozen(LISTING_SCHEMA));
  });

  test('readProducts returns the products array or null', () => {
    assert.deepEqual(readProducts({ products: [{ sku: 'A' }] }), [{ sku: 'A' }]);
    assert.deepEqual(readProducts({ products: [] }), []);
    assert.equal(readProducts({ items: [] }), null);
    assert.equal(readProducts(null), null);
    assert.equal(readProducts([]), null);
  });
});