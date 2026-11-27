'use strict';

// NWP-PRICE-003: raw price formats and the price parser.
//
// VAT: Philippine retail and distributor prices are marketed VAT-inclusive, so a scraped price is
// stored exactly as listed, with no VAT added or removed (team decision, 2026-11-19).
//
// Prices are parsed into integer centavos. No floating-point arithmetic touches the amount, so
// "₱1,234.00", "PHP 1,234" and "1234" all become exactly 123400 centavos ("1234.00").
//
// Other currencies, extra text and malformed numbers are rejected (reason "invalid_price") and the
// record goes to the failure handling in NWP-PRICE-004 instead of being stored.
//
// Ranges ("₱1,000 - ₱1,200"): a store shows one when a listing has variants. By default they are
// rejected. Scraped prices are parsed with { rangeUpperBound: true } (normalize-record.js), which
// stores the HIGHER end (decision by G, 2026-11-26: the conservative figure for a budget estimate).
// Both ends must be valid PHP amounts on their own, or the range is rejected. Manual prices
// (pricing:set-manual) never accept a range: a person enters one verified amount.

const INVALID_PRICE = 'invalid_price';

/**
 * Reference list of raw prices: the input spec for parsePrice(). The tests run every entry, so this
 * list is also the executable specification. Add new real-world formats here first.
 *
 * @type {{ accepted: Array<{ raw: string|number, decimal: string, note?: string }>,
 *          rejected: Array<{ raw: *, why: string }> }}
 */
const PRICE_FORMAT_EXAMPLES = Object.freeze({
  accepted: Object.freeze([
    { raw: '₱1,234.00', decimal: '1234.00' },
    { raw: '₱ 1,234.00', decimal: '1234.00' },
    { raw: 'PHP 1,234.00', decimal: '1234.00' },
    { raw: 'Php1234', decimal: '1234.00' },
    { raw: 'php 1,234', decimal: '1234.00' },
    { raw: 'PhP 1,234', decimal: '1234.00' },
    { raw: 'P1,234.00', decimal: '1234.00', note: '"P" is read as pesos (common when ₱ cannot be typed)' },
    { raw: 'P 1,234.00', decimal: '1234.00' },
    { raw: 'p1234', decimal: '1234.00' },
    { raw: '1,234.00 PHP', decimal: '1234.00' },
    { raw: '1,234.00 P', decimal: '1234.00' },
    { raw: '1,234.00₱', decimal: '1234.00' },
    { raw: '1,234.00', decimal: '1234.00' },
    { raw: '1234', decimal: '1234.00' },
    { raw: '1234.5', decimal: '1234.50' },
    { raw: ' ₱1,234.00 ', decimal: '1234.00', note: 'non-breaking spaces around the value' },
    { raw: '₱ 1,234.00', decimal: '1234.00', note: 'non-breaking space after the symbol' },
    { raw: '１２３４', decimal: '1234.00', note: 'full-width digits' },
    { raw: '₱1,234,567.89', decimal: '1234567.89' },
    { raw: '0.50', decimal: '0.50' },
    { raw: 3990, decimal: '3990.00', note: 'a number instead of a string from the JSON extraction' },
    { raw: 1234.5, decimal: '1234.50' },
  ]),
  rejected: Object.freeze([
    { raw: '', why: 'empty' },
    { raw: '   ', why: 'empty' },
    { raw: null, why: 'not a string or number' },
    { raw: undefined, why: 'not a string or number' },
    { raw: { amount: 1234 }, why: 'not a string or number' },
    { raw: '1,000 - 1,200', why: 'price range (unless rangeUpperBound; see RANGE_EXAMPLES)' },
    { raw: '₱1,000–₱1,200', why: 'price range (unless rangeUpperBound)' },
    { raw: '1000 to 1200', why: 'price range (unless rangeUpperBound)' },
    { raw: '$1,234', why: 'not PHP' },
    { raw: 'USD 1,234', why: 'not PHP' },
    { raw: '€1.234,00', why: 'not PHP' },
    { raw: '0', why: 'zero' },
    { raw: '₱0.00', why: 'zero' },
    { raw: '-1234', why: 'negative' },
    { raw: '₱-1,234', why: 'negative' },
    { raw: -1234, why: 'negative' },
    { raw: '1234.567', why: 'more than two decimal places' },
    { raw: '12,34', why: 'malformed thousands separators' },
    { raw: '1.234,00', why: 'malformed (European separators)' },
    { raw: '1 234', why: 'malformed (space as thousands separator)' },
    { raw: 'Call for price', why: 'no amount' },
    { raw: 'Sold out', why: 'no amount' },
    { raw: '₱1,234.00 VAT inclusive', why: 'extra text after the amount' },
    { raw: '₱₱1,234', why: 'malformed (two peso markers)' },
    { raw: 'PHP P1,234', why: 'malformed (two peso markers)' },
    { raw: 'Price 1,234', why: 'extra text before the amount' },
    { raw: 1e21, why: 'too large / exponent notation' },
    { raw: Number.NaN, why: 'not a finite number' },
  ]),
});

/**
 * Ranges with { rangeUpperBound: true }: the input spec for scraped listing prices (Shoppable shows
 * ranges for listings with variants). The tests run every entry.
 */
const RANGE_EXAMPLES = Object.freeze({
  accepted: Object.freeze([
    { raw: '₱1,000 - ₱1,200', decimal: '1200.00' },
    { raw: '₱1,000–₱1,200', decimal: '1200.00', note: 'en dash, no spaces' },
    { raw: '₱1,000.50 — ₱1,200.75', decimal: '1200.75', note: 'em dash, centavos' },
    { raw: '1,000 - 1,200', decimal: '1200.00', note: 'no peso markers' },
    { raw: 'PHP 1,000 to PHP 1,200', decimal: '1200.00' },
    { raw: '1000 to 1200', decimal: '1200.00' },
    { raw: '₱1,000 - 1,200', decimal: '1200.00', note: 'marker on one end only' },
    { raw: '₱1,200 - ₱1,000', decimal: '1200.00', note: 'reversed: still the higher end' },
    { raw: '₱1,200 - ₱1,200', decimal: '1200.00', note: 'both ends equal' },
  ]),
  rejected: Object.freeze([
    { raw: '₱1,000 - Call for price', why: 'one end is not an amount' },
    { raw: '₱1,000 -', why: 'missing upper end' },
    { raw: '$1,000 - $1,200', why: 'not PHP' },
    { raw: '₱0 - ₱1,200', why: 'an end is zero' },
    { raw: '₱1,000 - ₱1,200 - ₱1,500', why: 'more than two ends' },
    { raw: 'from ₱18,825.00', why: 'a lower bound only, not a range' },
    { raw: '₱1,000 - ₱1,200 VAT inclusive', why: 'extra text after the amount' },
  ]),
});

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const UNUSUAL_SPACES = /[   -   　]/g;
const LEADING_MINUS = /^[-−]/;
const RANGE = /\d\s*(?:-|–|—|\bto\b)\s*(?:₱|php|p)?\s*-?\d/i;
// Splits "<low> <separator> <high>"; each end is then parsed as a single amount.
const RANGE_SPLIT = /\s*(?:\s-\s|–|—|(?<=\d)-(?=\s*(?:₱|php|p)?\s*\d)|\bto\b)\s*/i;
const OTHER_CURRENCY = /[$€£¥₹]|\b(?:USD|EUR|GBP|SGD|JPY|AUD|CAD|HKD|CNY|RMB|MYR|IDR|THB|VND|KRW)\b/i;
// Peso markers: the ₱ sign, "PHP" or "P", case-insensitive, before or after the amount (team decision, 2026-11-19).
const PHP_PREFIX = /^(?:₱|php|p)\s*/i;
const PHP_SUFFIX = /\s*(?:₱|php|p)$/i;
// Either well-formed comma groups (1,234,567) or plain digits, then up to two decimal places.
const AMOUNT = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

function reject(detail) {
  return { ok: false, reason: INVALID_PRICE, detail };
}

function cleanText(text) {
  return text
    .normalize('NFKC')          // full-width digits and symbols to ASCII
    .replace(ZERO_WIDTH, '')
    .replace(UNUSUAL_SPACES, ' ')
    .trim();
}

function formatDecimal(centavos) {
  const pesos = Math.floor(centavos / 100);
  const cents = centavos % 100;
  return `${pesos}.${String(cents).padStart(2, '0')}`;
}

/**
 * Parses one raw scraped price into integer centavos and a two-decimal string.
 *
 * @param {*} raw  Usually a string from Firecrawl's JSON extraction; finite numbers are accepted too.
 * @returns {{ ok: true, centavos: number, decimal: string }
 *         | { ok: false, reason: 'invalid_price', detail: string }}
 */
function parsePrice(raw, { rangeUpperBound = false } = {}) {
  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return reject('Price is not a finite number.');
    text = String(raw); // e.g. 1234.5 -> "1234.5"; 1e21 -> "1e+21", which is rejected below
  } else {
    return reject('Price is not a string or number.');
  }

  text = cleanText(text);
  if (text.length === 0) return reject('Price is empty.');
  if (LEADING_MINUS.test(text)) return reject('Price is negative.');
  if (RANGE.test(text)) {
    if (!rangeUpperBound) return reject('Price is a range, not a single amount.');
    return parseRange(text);
  }
  return parseSingle(text);
}

// "<low> - <high>": both ends must be valid amounts on their own; the higher one is returned.
function parseRange(text) {
  const ends = text.split(RANGE_SPLIT).filter((part) => part.length > 0);
  if (ends.length !== 2) return reject('Price range could not be read as two amounts.');
  const parsed = ends.map((end) => parseSingle(end));
  const bad = parsed.find((end) => !end.ok);
  if (bad) return reject(`Price range has an end that is not usable: ${bad.detail}`);
  const high = parsed[0].centavos >= parsed[1].centavos ? parsed[0] : parsed[1];
  const low = high === parsed[0] ? parsed[1] : parsed[0];
  return { ...high, fromRange: true, rangeLowDecimal: low.decimal };
}

function parseSingle(text) {
  if (OTHER_CURRENCY.test(text)) return reject('Price is not in Philippine pesos.');

  const amountText = text.replace(PHP_PREFIX, '').replace(PHP_SUFFIX, '');
  if (LEADING_MINUS.test(amountText)) return reject('Price is negative.');

  const match = AMOUNT.exec(amountText);
  if (!match) return reject('Price is not a recognised PHP amount.');

  const integerDigits = match[1].replace(/,/g, '');
  const fractionDigits = (match[2] || '').padEnd(2, '0');
  const centavos = Number(integerDigits) * 100 + Number(fractionDigits);

  if (!Number.isSafeInteger(centavos)) return reject('Price is too large.');
  if (centavos === 0) return reject('Price is zero.');

  return { ok: true, centavos, decimal: formatDecimal(centavos) };
}

module.exports = {
  parsePrice,
  formatDecimal,
  PRICE_FORMAT_EXAMPLES,
  RANGE_EXAMPLES,
  INVALID_PRICE,
};
