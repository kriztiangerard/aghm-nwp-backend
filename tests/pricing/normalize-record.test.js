'use strict';

// NWP-PRICE-003: normalization of listing-page products. Runs with node:test.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRecord, normalizeListing, normalizeSku, buildSkuIndex, NORMALIZE_REJECT_REASONS: R, matchSku } = require('../../src/pricing/normalize-record');

const SOURCE = { sourceId: 7, vendorId: 2, distributorId: 3 };
const RETRIEVED_AT = '2026-11-22T18:05:00.000Z';
const INDEX = buildSkuIndex([
  { deviceId: 42, sku: 'ER605' },
  { deviceId: 43, sku: 'EAP610' },
  { deviceId: 44, sku: 'SG2008P' },
]);

describe('buildSkuIndex', () => {
  test('maps normalized SKUs to device ids', () => {
    assert.equal(INDEX.get('ER605'), 42);
    assert.equal(INDEX.get('SG2008P'), 44);
    assert.equal(INDEX.size, 3);
  });

  test('throws when two devices normalize to the same SKU', () => {
    assert.throws(() => buildSkuIndex([{ deviceId: 1, sku: 'ER605' }, { deviceId: 2, sku: ' er605 ' }]), /both normalize/);
  });

  test('throws on malformed device rows', () => {
    assert.throws(() => buildSkuIndex([{ deviceId: 0, sku: 'ER605' }]), TypeError);
    assert.throws(() => buildSkuIndex([{ deviceId: 1, sku: '  ' }]), TypeError);
    assert.throws(() => buildSkuIndex(null), TypeError);
  });
});

describe('normalizeRecord: accepted products', () => {
  test('returns device, distributor, source, price and retrieval time', () => {
    const result = normalizeRecord({ sku: 'ER605', price: '₱3,990.00' }, SOURCE, INDEX, RETRIEVED_AT);

    assert.deepEqual(result, {
      ok: true,
      record: {
        deviceId: 42,
        distributorId: 3,
        sourceId: 7,
        price: '3990.00',
        priceCentavos: 399000,
        retrievedAt: new Date(RETRIEVED_AT),
        pageSku: 'ER605',
      },
    });
  });

  test('matches the SKU regardless of case and spacing', () => {
    const result = normalizeRecord({ sku: ' er605 ', price: '3990' }, SOURCE, INDEX, RETRIEVED_AT);

    assert.equal(result.record.deviceId, 42);
  });

  test('differently formatted prices for the same amount give identical prices', () => {
    const a = normalizeRecord({ sku: 'ER605', price: '₱3,990.00' }, SOURCE, INDEX, RETRIEVED_AT);
    const b = normalizeRecord({ sku: 'ER605', price: 'P 3990' }, SOURCE, INDEX, RETRIEVED_AT);

    assert.equal(a.record.price, b.record.price);
    assert.equal(a.record.priceCentavos, b.record.priceCentavos);
  });

  test('copies retrievedAt instead of keeping the caller\'s Date', () => {
    const when = new Date(RETRIEVED_AT);
    const result = normalizeRecord({ sku: 'ER605', price: '3990' }, SOURCE, INDEX, when);
    when.setFullYear(2000);

    assert.equal(result.record.retrievedAt.toISOString(), RETRIEVED_AT);
  });

  test('price is stored as listed (VAT-inclusive, no adjustment)', () => {
    const result = normalizeRecord({ sku: 'ER605', price: '₱1,120.00' }, SOURCE, INDEX, RETRIEVED_AT);

    assert.equal(result.record.price, '1120.00');
  });
});

describe('normalizeRecord: rejected products', () => {
  const cases = [
    ['no SKU', { price: '3990' }, R.MISSING_FIELD],
    ['blank SKU', { sku: '  ', price: '3990' }, R.MISSING_FIELD],
    ['nothing extracted', null, R.MISSING_FIELD],
    ['SKU not in the vendor catalog', { sku: 'ER7206', price: '3990' }, R.NO_SKU_MATCH],
    ['SKU with extra text', { sku: 'ER605 V2', price: '3990' }, R.NO_SKU_MATCH],
    ['no price', { sku: 'ER605' }, R.MISSING_FIELD],
    ['price range', { sku: 'ER605', price: '3,500 - 3,990' }, R.INVALID_PRICE],
    ['foreign currency', { sku: 'ER605', price: '$75' }, R.INVALID_PRICE],
    ['zero price', { sku: 'ER605', price: '₱0.00' }, R.INVALID_PRICE],
    ['text instead of price', { sku: 'ER605', price: 'Call for price' }, R.INVALID_PRICE],
  ];

  for (const [label, raw, reason] of cases) {
    test(`${label} → ${reason}`, () => {
      const result = normalizeRecord(raw, SOURCE, INDEX, RETRIEVED_AT);

      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
      assert.equal(typeof result.detail, 'string');
      assert.equal(result.record, undefined);
    });
  }

  test('a product outside the catalog is reported before a bad price', () => {
    const result = normalizeRecord({ sku: 'ER7206', price: 'Call for price' }, SOURCE, INDEX, RETRIEVED_AT);

    assert.equal(result.reason, R.NO_SKU_MATCH);
  });

  test('a rejection for a matched device carries its deviceId', () => {
    const result = normalizeRecord({ sku: 'ER605', price: 'Call for price' }, SOURCE, INDEX, RETRIEVED_AT);

    assert.equal(result.deviceId, 42);
  });

  test('detail quotes the scraped value, shortened', () => {
    const result = normalizeRecord({ sku: 'ER605', price: `₱${'9'.repeat(200)}` }, SOURCE, INDEX, RETRIEVED_AT);

    assert.ok(result.detail.includes('Raw value:'));
    assert.ok(result.detail.length < 200);
  });

  test('reasons match the NWP-PRICE-004 status values', () => {
    assert.deepEqual(Object.values(R).sort(), ['invalid_price', 'missing_field', 'no_sku_match']);
  });
});

describe('normalizeListing', () => {
  test('keeps catalog products, counts the rest as unmatched', () => {
    const result = normalizeListing([
      { sku: 'ER605', price: '₱3,990' },
      { sku: 'EAP610', price: '₱3,450' },
      { sku: 'Archer AX55', price: '₱4,999' },
      { sku: 'Deco X20', price: '₱5,999' },
    ], SOURCE, INDEX, RETRIEVED_AT);

    assert.deepEqual(result.records.map((r) => [r.deviceId, r.price]), [[42, '3990.00'], [43, '3450.00']]);
    assert.equal(result.unmatched, 2);
    assert.deepEqual(result.rejected, []);
  });

  test('reports matched products whose price cannot be used', () => {
    const result = normalizeListing([
      { sku: 'ER605', price: '₱3,990' },
      { sku: 'SG2008P', price: 'Call for price' },
    ], SOURCE, INDEX, RETRIEVED_AT);

    assert.equal(result.records.length, 1);
    assert.deepEqual(result.rejected.map((r) => [r.deviceId, r.reason]), [[44, R.INVALID_PRICE]]);
  });

  test('a device listed twice at the same price is kept once', () => {
    const result = normalizeListing([
      { sku: 'ER605', price: '₱3,990' },
      { sku: 'er605', price: '3990.00' },
    ], SOURCE, INDEX, RETRIEVED_AT);

    assert.equal(result.records.length, 1);
    assert.deepEqual(result.rejected, []);
  });

  test('a device listed twice at different prices is rejected, no price is picked', () => {
    const result = normalizeListing([
      { sku: 'ER605', price: '₱3,990' },
      { sku: 'ER605', price: '₱4,190' },
      { sku: 'EAP610', price: '₱3,450' },
    ], SOURCE, INDEX, RETRIEVED_AT);

    assert.deepEqual(result.records.map((r) => r.deviceId), [43]);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].deviceId, 42);
    assert.equal(result.rejected[0].reason, R.INVALID_PRICE);
    assert.match(result.rejected[0].detail, /3990\.00, 4190\.00/);
  });

  test('a missing or non-array product list gives no records', () => {
    for (const products of [undefined, null, {}, 'ER605']) {
      assert.deepEqual(normalizeListing(products, SOURCE, INDEX, RETRIEVED_AT), { records: [], rejected: [], unmatched: 0 });
    }
  });
});

describe('programmer errors throw', () => {
  test('missing or invalid source fields', () => {
    const raw = { sku: 'ER605', price: '3990' };
    assert.throws(() => normalizeRecord(raw, null, INDEX, RETRIEVED_AT), TypeError);
    assert.throws(() => normalizeRecord(raw, { ...SOURCE, vendorId: 0 }, INDEX, RETRIEVED_AT), /vendorId/);
    assert.throws(() => normalizeRecord(raw, { ...SOURCE, sourceId: '7' }, INDEX, RETRIEVED_AT), /sourceId/);
  });

  test('skuIndex must come from buildSkuIndex', () => {
    assert.throws(() => normalizeRecord({ sku: 'ER605', price: '3990' }, SOURCE, {}, RETRIEVED_AT), /skuIndex/);
  });

  test('invalid retrievedAt', () => {
    assert.throws(() => normalizeListing([], SOURCE, INDEX, 'not a date'), /retrievedAt/);
  });
});

describe('normalizeSku', () => {
  test('trims, uppercases and collapses whitespace', () => {
    assert.equal(normalizeSku('  er605  '), 'ER605');
    assert.equal(normalizeSku('sg2210  mp'), 'SG2210 MP');
    assert.equal(normalizeSku('ＥＲ６０５'), 'ER605');
    assert.equal(normalizeSku('ER​605'), 'ER605');
  });

  test('keeps hyphens and other punctuation', () => {
    assert.equal(normalizeSku('tl-sg1008p'), 'TL-SG1008P');
  });

  test('returns null when there is no usable SKU', () => {
    for (const raw of ['', '   ', undefined, {}]) assert.equal(normalizeSku(raw), null);
  });
});

describe('matchSku: layered, never guessing (store spellings)', () => {
  // Real catalog SKUs, including TP-Link's reused base number: two different switches.
  const index = buildSkuIndex([
    { deviceId: 1, sku: 'SG2008' },
    { deviceId: 2, sku: 'SG2008P' },
    { deviceId: 3, sku: 'U6-Pro' },
    { deviceId: 4, sku: 'U7-Pro-XG' },
    { deviceId: 5, sku: 'RG-RAP2266' },
    { deviceId: 6, sku: 'SG3428XPP-M2' },      // Omada Access Pro
    { deviceId: 7, sku: 'TL-SG3428XPP-M2' },   // JetStream, a different switch
    { deviceId: 8, sku: 'EAP683 UR' },
  ]);

  test('exact matches still win', () => {
    assert.equal(matchSku(index, 'u6-pro'), 3);
    assert.equal(matchSku(index, 'TL-SG3428XPP-M2'), 7);
    assert.equal(matchSku(index, 'SG3428XPP-M2'), 6);
  });

  test('separators are ignored: U6-PRO, U6 Pro, u6pro, U6_Pro', () => {
    for (const sku of ['U6-PRO', 'U6 Pro', 'u6pro', 'U6_Pro', 'U6.Pro']) assert.equal(matchSku(index, sku), 3, sku);
    assert.equal(matchSku(index, 'EAP683-UR'), 8);
    assert.equal(matchSku(index, 'SG3428XPP M2'), 6);       // still the Access Pro, not the JetStream
    assert.equal(matchSku(index, 'TL SG3428XPP M2'), 7);    // still the JetStream
  });

  test('a brand prefix is ignored on either side when only one device fits', () => {
    assert.equal(matchSku(index, 'TL-SG2008'), 1);
    assert.equal(matchSku(index, 'TP-Link SG2008P'), 2);
    assert.equal(matchSku(index, 'RAP2266'), 5);
    assert.equal(matchSku(index, 'Ruijie RG-RAP2266'), 5);
    assert.equal(matchSku(index, 'UniFi U6 Pro'), 3);
  });

  test('an ambiguous model number never matches (TP-Link SG3428XPP-M2 vs TL-SG3428XPP-M2)', () => {
    assert.equal(matchSku(index, 'TP-Link SG3428XPP-M2'), undefined);   // could be either switch
  });

  test('letters and digits are never dropped, and suffixes still matter', () => {
    assert.equal(matchSku(index, 'SG2008-P'), 2);          // same letters: SG2008P
    assert.equal(matchSku(index, 'U7-Pro'), undefined);    // not U7-Pro-XG
    assert.equal(matchSku(index, 'U6-Pro-Max'), undefined);
    assert.equal(matchSku(index, 'SG2008 (UN)'), undefined);   // region suffixes are not stripped
    assert.equal(matchSku(index, ''), undefined);
  });

  test('normalizeListing uses it: a store listing in its own spelling is priced', () => {
    const products = [
      { sku: 'TL-SG2008', price: '₱2,190.00' },
      { sku: 'U6 Pro', price: '₱9,450' },
      { sku: 'TP-Link SG3428XPP-M2', price: '₱30,000' },
    ];
    const result = normalizeListing(products, SOURCE, index, RETRIEVED_AT);
    assert.deepEqual(result.records.map((r) => [r.deviceId, r.price, r.pageSku]), [[1, '2190.00', 'TL-SG2008'], [3, '9450.00', 'U6 Pro']]);
    assert.equal(result.unmatched, 1);   // the ambiguous one is skipped, not guessed
  });
});
