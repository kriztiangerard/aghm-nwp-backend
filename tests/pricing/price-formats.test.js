'use strict';

// NWP-PRICE-003: price parser. Runs with node:test. PRICE_FORMAT_EXAMPLES is the executable spec.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePrice, formatDecimal, PRICE_FORMAT_EXAMPLES } = require('../../src/pricing/price-formats');

describe('parsePrice: reference list', () => {
  for (const { raw, decimal } of PRICE_FORMAT_EXAMPLES.accepted) {
    test(`accepts ${JSON.stringify(raw)} as ${decimal}`, () => {
      const result = parsePrice(raw);

      assert.equal(result.ok, true);
      assert.equal(result.decimal, decimal);
      assert.equal(Number.isSafeInteger(result.centavos), true);
    });
  }

  for (const { raw, why } of PRICE_FORMAT_EXAMPLES.rejected) {
    test(`rejects ${JSON.stringify(raw) || String(raw)} (${why})`, () => {
      const result = parsePrice(raw);

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid_price');
      assert.equal(typeof result.detail, 'string');
    });
  }
});

describe('parsePrice: story checks', () => {
  test('"₱1,234.00", "PHP 1,234" and "1234" all give 1234.00', () => {
    for (const raw of ['₱1,234.00', 'PHP 1,234', '1234']) {
      assert.deepEqual(parsePrice(raw), { ok: true, centavos: 123400, decimal: '1234.00' });
    }
  });

  test('"1,000 - 1,200" and "$1,234" are rejected', () => {
    assert.equal(parsePrice('1,000 - 1,200').ok, false);
    assert.equal(parsePrice('$1,234').ok, false);
  });

  test('a range is never resolved to one of its ends', () => {
    const result = parsePrice('₱1,000 - ₱1,200');

    assert.equal(result.ok, false);
    assert.match(result.detail, /range/);
  });

  test('₱, PHP and P are accepted before or after the amount, in any case', () => {
    for (const raw of ['₱1,234', 'PHP1,234', 'php 1,234', 'P1,234', 'p 1,234', '1,234 PHP', '1,234 p', '1,234₱']) {
      assert.equal(parsePrice(raw).decimal, '1234.00', raw);
    }
  });
});

describe('parsePrice: integer arithmetic', () => {
  test('amounts that are inexact in floating point stay exact', () => {
    assert.equal(parsePrice('0.10').centavos + parsePrice('0.20').centavos, 30);
    assert.equal(parsePrice('19,999.99').centavos, 1999999);
    assert.equal(parsePrice('1234.05').decimal, '1234.05');
  });

  test('very large but safe amounts are exact', () => {
    assert.deepEqual(parsePrice('90,071,992,547,409.91'), { ok: true, centavos: 9007199254740991, decimal: '90071992547409.91' });
  });

  test('amounts beyond safe integer range are rejected, not rounded', () => {
    const result = parsePrice('90,071,992,547,409.92');

    assert.equal(result.ok, false);
    assert.match(result.detail, /too large/);
  });
});

describe('formatDecimal', () => {
  test('always gives two decimal places', () => {
    assert.equal(formatDecimal(123400), '1234.00');
    assert.equal(formatDecimal(5), '0.05');
    assert.equal(formatDecimal(123450), '1234.50');
  });
});
