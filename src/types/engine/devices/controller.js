'use strict';

// NWP-ENGINE-018: Controller selection.
// Pure functions (no I/O, clock or randomness). CommonJS, to match the other Lambda code.
//
//   countManagedDevices(items)                                -> {aps, switches, gateways}
//   integratedControllerCheck(gatewayRow, ctx[, counts])      -> boolean
//   selectController(vendor, planType, counts, catalog, ctx)  -> SelectionResult
//
// Controllers have no product line (device-schemas.json, controllerDevice), so the line_rank rule of the
// gateway, switch and AP selectors does not apply. A controller is chosen by sizing: the planned AP, switch and
// gateway counts must fit its managed-device limits.
//
// The shared helpers in select.js are reused where they apply (lifecycle filter, unpriced exclusion,
// price-then-SKU order, unmet recording). selectSku() itself is not used, because it has no way to give the
// controller-specific unmet reasons AC7 asks for and its High-Performance step is line_rank based.

const {
  filterByLifecycle,
  excludeUnpriced,
  cheapestSku,
  unmetResult,
  UNPRICED_FLAG_CODE,
} = require('../select.js');
const { addFlag } = require('../ctx.js');
const params = require('../params.js');

const CATEGORY = 'controller';

// Integrated controllers are not separately purchasable (device-schemas.json, controllerSpecs).
const PURCHASABLE_TYPES = new Set(['hardware', 'software', 'cloud']);

const FLAG_CODES = Object.freeze({
  CAPACITY_NOT_VERIFIED: 'CONTROLLER_CAPACITY_NOT_VERIFIED',
  INTEGRATED_CAPACITY_EXCEEDED: 'CONTROLLER_INTEGRATED_CAPACITY_EXCEEDED',
  SUNSETTING: 'CONTROLLER_SUNSETTING',
});

// plan.items category -> counts key.
const COUNT_KEY_BY_CATEGORY = new Map([
  ['access_point', 'aps'],
  ['switch', 'switches'],
  ['gateway', 'gateways'],
]);

// The three per-type limits, required on every controller row by validateCatalogSku().
const PER_TYPE_LIMITS = Object.freeze([
  { key: 'aps', limit: 'max_managed_aps', label: 'APs' },
  { key: 'switches', limit: 'max_managed_switches', label: 'switches' },
  { key: 'gateways', limit: 'max_managed_gateways', label: 'gateways' },
]);
const COMBINED_LIMIT = Object.freeze({ limit: 'max_managed_aps_and_switches', label: 'APs and switches combined' });

// Ratios are compared with a small tolerance. It is not needed for the 30% bound (13 / 10 and 1 + 0.3 are the same
// double), but it keeps the comparison safe if the bound is changed to a value that does not round-trip.
const RATIO_EPSILON = 1e-9;

const isPresent = (value) => value !== undefined && value !== null;
const isCount = (value) => Number.isInteger(value) && value >= 0;

function assertCounts(counts) {
  if (!counts || typeof counts !== 'object' || !['aps', 'switches', 'gateways'].every((key) => isCount(counts[key]))) {
    throw new TypeError('counts must be {aps, switches, gateways} with non-negative integers.');
  }
}

function assertCtx(ctx) {
  if (!ctx || !Array.isArray(ctx.flags) || !Array.isArray(ctx.unmet)) {
    throw new TypeError('ctx from createCtx() is required.');
  }
}

function raiseFlag(ctx, flags, code, message) {
  addFlag(ctx, code, message);
  flags.push({ code, message });
}

/**
 * Subtask 1. Number of managed devices in a plan: the sum of qty per category.
 * gateways is 2 when NWP-ENGINE-008 set the gateway quantity to 2 for HA pairing (AC4).
 * Categories that are not managed by a controller (controller, enclosure, ...) are ignored.
 * @param {{category: string, qty: number}[]} items  plan.items
 * @returns {{aps: number, switches: number, gateways: number}}
 */
function countManagedDevices(items) {
  if (!Array.isArray(items)) {
    throw new TypeError('countManagedDevices: items must be an array.');
  }
  const counts = { aps: 0, switches: 0, gateways: 0 };
  for (const item of items) {
    const key = COUNT_KEY_BY_CATEGORY.get(item?.category);
    if (key === undefined) continue;
    if (!isCount(item.qty)) {
      throw new TypeError(`countManagedDevices: qty of ${item.category} item '${item.sku}' must be a non-negative integer.`);
    }
    counts[key] += item.qty;
  }
  return counts;
}

/**
 * Limits of a row that the counts exceed (AC3). Every comparison is inclusive: a count equal to the limit fits.
 * The combined cap is applied only when the row states one. A per-type limit that is not a number cannot be
 * checked, so it is reported as exceeded rather than assumed to fit.
 * @returns {{label: string, limit: number|null, need: number}[]}
 */
function exceededLimits(row, counts) {
  const exceeded = [];
  for (const { key, limit, label } of PER_TYPE_LIMITS) {
    const value = row[limit];
    if (!Number.isFinite(value) || counts[key] > value) {
      exceeded.push({ label, limit: Number.isFinite(value) ? value : null, need: counts[key] });
    }
  }
  const combined = row[COMBINED_LIMIT.limit];
  const combinedNeed = counts.aps + counts.switches;
  if (isPresent(combined) && (!Number.isFinite(combined) || combinedNeed > combined)) {
    exceeded.push({ label: COMBINED_LIMIT.label, limit: Number.isFinite(combined) ? combined : null, need: combinedNeed });
  }
  return exceeded;
}

const describeExceeded = (exceeded) =>
  exceeded
    .map(({ label, limit, need }) => (limit === null
      ? `no stated limit for ${label}, plan needs ${need}`
      : `manages up to ${limit} ${label}, plan needs ${need}`))
    .join('; ');

/** AC3 as a predicate. */
function controllerFits(row, counts) {
  assertCounts(counts);
  return exceededLimits(row, counts).length === 0;
}

function hasIntegratedController(row) {
  return (Array.isArray(row.capabilities) && row.capabilities.includes('controller')) ||
    row.controller_type === 'integrated';
}

/**
 * Subtask 2 (AC1). Does the selected gateway already contain the controller?
 *
 * - No marker ('controller' in capabilities, or controller_type 'integrated'): false, nothing raised.
 * - Marker, and the gateway row states its three per-type limits, and counts is given: the limits are checked.
 *     fits     -> true, nothing raised (the built-in controller is verified).
 *     exceeded -> false and CONTROLLER_INTEGRATED_CAPACITY_EXCEEDED, so a standalone controller is selected.
 * - Marker, but counts is not given or the limits are not on the row: true and CONTROLLER_CAPACITY_NOT_VERIFIED
 *   (the message names the gateway SKU and says its limits were not checked). The engine never guesses a limit.
 *
 * @param {Object} gatewayRow  the plan's selected gateway CatalogSku
 * @param {Object} ctx
 * @param {{aps: number, switches: number, gateways: number}} [counts]  from countManagedDevices()
 * @returns {boolean} true when no separate controller is needed
 */
function integratedControllerCheck(gatewayRow, ctx, counts) {
  if (!gatewayRow || typeof gatewayRow !== 'object') {
    throw new TypeError('gatewayRow must be a catalog row.');
  }
  assertCtx(ctx);
  if (!hasIntegratedController(gatewayRow)) return false;

  const limitsKnown = PER_TYPE_LIMITS.every(({ limit }) => Number.isFinite(gatewayRow[limit]));
  if (counts === undefined || !limitsKnown) {
    addFlag(
      ctx,
      FLAG_CODES.CAPACITY_NOT_VERIFIED,
      `Gateway ${gatewayRow.sku} has a built-in controller; its managed-device limits were not checked against the planned devices.`,
    );
    return true;
  }

  assertCounts(counts);
  const exceeded = exceededLimits(gatewayRow, counts);
  if (exceeded.length === 0) return true;

  addFlag(
    ctx,
    FLAG_CODES.INTEGRATED_CAPACITY_EXCEEDED,
    `The built-in controller of gateway ${gatewayRow.sku} cannot manage the planned devices (${describeExceeded(exceeded)}); a separate controller is selected instead.`,
  );
  return false;
}

const withNormalizedStatus = (sku) => ({
  ...sku,
  status: String(sku.status ?? sku.lifecycle_status ?? '').toUpperCase(),
});

/**
 * Subtask 3 (AC2). Rows that can be bought as a separate controller for this vendor.
 * Lifecycle rules (DISCONTINUED excluded) are applied afterwards with filterByLifecycle().
 * Pure: returns new objects.
 */
function collectControllerCandidates(catalog, vendor) {
  if (!Array.isArray(catalog)) {
    throw new TypeError('catalog must be an array.');
  }
  return catalog
    .filter((sku) =>
      sku &&
      sku.category === CATEGORY &&
      sku.vendor === vendor &&
      PURCHASABLE_TYPES.has(sku.controller_type))
    .map(withNormalizedStatus);
}

/**
 * Subtask 6 (AC6). The smallest of limit / count over the dimensions whose count is above 0
 * (APs, switches, gateways, and the combined cap when present). Headroom = ratio - 1.
 * With no dimension above 0 there is nothing to manage, so the ratio is Infinity.
 * Ratios are kept (not ratio - 1) so the comparison with the bound has no subtraction error.
 */
function headroomRatio(row, counts) {
  const ratios = [];
  for (const { key, limit } of PER_TYPE_LIMITS) {
    if (counts[key] > 0) ratios.push(row[limit] / counts[key]);
  }
  const combinedNeed = counts.aps + counts.switches;
  if (isPresent(row[COMBINED_LIMIT.limit]) && combinedNeed > 0) {
    ratios.push(row[COMBINED_LIMIT.limit] / combinedNeed);
  }
  return ratios.length > 0 ? Math.min(...ratios) : Infinity;
}

const priceKey = (row) => (typeof row.price === 'number' && Number.isFinite(row.price) ? row.price : Infinity);

/** Price ascending (a null price ranks last), then SKU ascending. Plain string compare, so it is locale-free. */
function comparePriceThenSku(a, b) {
  const pa = priceKey(a);
  const pb = priceKey(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a.sku < b.sku) return -1;
  if (a.sku > b.sku) return 1;
  return 0;
}

/**
 * Subtask 6 (AC6). High-Performance pick among fitting candidates (null prices allowed).
 * 1. Candidates whose headroom does not exceed the shared bound (params.HP_HEADROOM_MAX, 30%) compete;
 *    the one with the highest headroom wins.
 * 2. If none is within the bound, the one with the smallest headroom wins.
 * Ties on headroom are broken by price ascending, then SKU.
 * @param {Array} fitting  non-empty
 */
function pickHighPerformance(fitting, counts) {
  const bound = params.HP_HEADROOM_MAX;
  if (!Number.isFinite(bound) || bound < 0) {
    throw new Error('params.HP_HEADROOM_MAX is required (the shared High-Performance headroom bound).');
  }
  const ranked = fitting.map((row) => ({ row, ratio: headroomRatio(row, counts) }));
  const within = ranked.filter(({ ratio }) => ratio <= 1 + bound + RATIO_EPSILON);

  const tied = (a, b) => a === b || Math.abs(a - b) <= RATIO_EPSILON;
  const order = (preferHigher) => (a, b) => {
    if (!tied(a.ratio, b.ratio)) {
      return (a.ratio > b.ratio ? 1 : -1) * (preferHigher ? -1 : 1);
    }
    return comparePriceThenSku(a.row, b.row);
  };

  const pool = within.length > 0 ? within : ranked;
  return [...pool].sort(order(within.length > 0))[0].row;
}

/**
 * Subtask 7 (AC7). The candidate closest to fitting, used to word the unmet reason:
 * fewest exceeded limits, then the smallest total shortfall (units over the limits), then SKU.
 */
function closestCandidate(candidates, counts) {
  const shortfall = (exceeded) =>
    exceeded.reduce((sum, { limit, need }) => sum + (limit === null ? need : need - limit), 0);
  return candidates
    .map((row) => {
      const exceeded = exceededLimits(row, counts);
      return { row, exceeded, shortfall: shortfall(exceeded) };
    })
    .sort((a, b) =>
      (a.exceeded.length - b.exceeded.length) ||
      (a.shortfall - b.shortfall) ||
      (a.row.sku < b.row.sku ? -1 : a.row.sku > b.row.sku ? 1 : 0))[0];
}

/**
 * Selection entry point. Call it only when the vendor needs a controller and integratedControllerCheck()
 * returned false.
 *
 * Programmer errors (bad arguments) throw. A requirement that cannot be met returns
 * {ok: false, unmet: {category: 'controller', vendor, reason}} and is recorded on ctx.unmet.
 *
 * @param {string} vendor
 * @param {'CE'|'HP'} planType
 * @param {{aps: number, switches: number, gateways: number}} counts
 * @param {Array} catalog  CatalogSku[]
 * @param {Object} ctx
 * @returns {import('../contracts').SelectionResult}
 */
function selectController(vendor, planType, counts, catalog, ctx) {
  if (typeof vendor !== 'string' || vendor.trim() === '') {
    throw new TypeError('vendor must be a non-empty string.');
  }
  if (planType !== 'CE' && planType !== 'HP') {
    throw new TypeError('planType must be CE or HP.');
  }
  assertCounts(counts);
  assertCtx(ctx);

  const candidates = collectControllerCandidates(catalog, vendor);
  if (candidates.length === 0) {
    const integratedOnly = catalog.some((sku) =>
      sku && sku.category === CATEGORY && sku.vendor === vendor && sku.controller_type === 'integrated');
    return unmetResult(
      ctx,
      CATEGORY,
      vendor,
      `No controller in the catalog for ${vendor}` +
        (integratedOnly ? ' (integrated controllers are not separately purchasable).' : '.'),
    );
  }

  const purchasable = filterByLifecycle(candidates);
  if (purchasable.length === 0) {
    return unmetResult(ctx, CATEGORY, vendor, `No purchasable (ACTIVE or SUNSETTING) controller for ${vendor}.`);
  }

  const fitting = purchasable.filter((row) => exceededLimits(row, counts).length === 0);
  if (fitting.length === 0) {
    const { row, exceeded } = closestCandidate(purchasable, counts);
    return unmetResult(
      ctx,
      CATEGORY,
      vendor,
      `No ${vendor} controller fits the planned devices; closest is ${row.sku}, which ${describeExceeded(exceeded)}.`,
    );
  }

  const flags = [];
  let pick;

  if (planType === 'CE') {
    // AC5: lowest price; a null price is excluded from the ranking.
    const { priced, excludedCount } = excludeUnpriced(fitting);
    if (priced.length === 0) {
      return unmetResult(
        ctx,
        CATEGORY,
        vendor,
        `The ${fitting.length} fitting ${vendor} controller(s) have no price, so the Cost-Efficient plan cannot rank them.`,
      );
    }
    if (excludedCount > 0) {
      raiseFlag(ctx, flags, UNPRICED_FLAG_CODE, 'unpriced SKUs excluded');
    }
    pick = cheapestSku(priced);
  } else {
    // AC6: a null price does not disqualify; the BOM total is then partial (NWP-BOM-001).
    pick = pickHighPerformance(fitting, counts);
  }

  if (pick.status === 'SUNSETTING') {
    raiseFlag(
      ctx,
      flags,
      FLAG_CODES.SUNSETTING,
      `Controller ${pick.sku} is sunsetting; confirm availability with the vendor before purchase.`,
    );
  }

  return { ok: true, sku: pick, qty: 1, flags };
}

module.exports = {
  countManagedDevices,
  integratedControllerCheck,
  selectController,
  collectControllerCandidates,
  controllerFits,
  headroomRatio,
  FLAG_CODES,
};