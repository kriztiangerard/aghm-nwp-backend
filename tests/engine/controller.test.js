'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCtx } = require('../../src/types/engine/ctx.js');
const params = require('../../src/types/engine/params.js');
const { validateSelectionResult, validateCatalogSku } = require('../../src/types/engine/contracts.js');
const {
  countManagedDevices,
  integratedControllerCheck,
  selectController,
  collectControllerCandidates,
  controllerFits,
  FLAG_CODES,
} = require('../../src/types/engine/devices/controller.js');
const {
  controller, gateway, accessPoint, switchRow, integratedGateway, counts, items, deepFreeze, clone,
} = require('../fixtures/e18-fixtures.js');

const select = (plan, c, catalog, vendor = 'V') => {
  const ctx = createCtx();
  const result = selectController(vendor, plan, c, catalog, ctx);
  return { result, ctx };
};
const picked = (plan, c, catalog) => select(plan, c, catalog).result.sku?.sku;

// ---------------------------------------------------------------------------------------------
// Fixtures are real catalog rows
// ---------------------------------------------------------------------------------------------

test('fixture rows pass validateCatalogSku', () => {
  [controller('C1'), controller('C2', { controller_type: 'software' }), gateway('G1'), accessPoint('A1'),
    switchRow('S1'), integratedGateway('G2')].forEach((row) => assert.equal(validateCatalogSku(row), true));
});

test('params defines the shared High-Performance headroom bound (30%)', () => {
  assert.equal(params.HP_HEADROOM_MAX, 0.3);
});

// ---------------------------------------------------------------------------------------------
// Subtask 1: countManagedDevices (AC4)
// ---------------------------------------------------------------------------------------------

test('countManagedDevices sums qty per category across several items', () => {
  const result = countManagedDevices([
    { category: 'gateway', sku: 'G', qty: 1 },
    { category: 'access_point', sku: 'A', qty: 12 },
    { category: 'switch', sku: 'CORE', qty: 1 },
    { category: 'switch', sku: 'ACC', qty: 3, floor: 1 },
    { category: 'switch', sku: 'ACC', qty: 2, floor: 2 },
  ]);
  assert.deepEqual(result, { aps: 12, switches: 6, gateways: 1 });
});

test('AC4: a gateway quantity of 2 (HA pair) gives counts.gateways 2', () => {
  assert.equal(countManagedDevices(items(4, 2, 2)).gateways, 2);
});

test('countManagedDevices ignores controllers, enclosures and unknown categories', () => {
  const result = countManagedDevices([
    { category: 'controller', sku: 'C', qty: 1 },
    { category: 'enclosure', sku: 'E', qty: 1 },
    { category: 'constructor', sku: 'X', qty: 5 },
    { category: 'access_point', sku: 'A', qty: 2 },
  ]);
  assert.deepEqual(result, { aps: 2, switches: 0, gateways: 0 });
});

test('countManagedDevices of no items is all zeros', () => {
  assert.deepEqual(countManagedDevices([]), { aps: 0, switches: 0, gateways: 0 });
});

test('countManagedDevices rejects a non-array and a bad qty on a counted item', () => {
  assert.throws(() => countManagedDevices(null), TypeError);
  assert.throws(() => countManagedDevices([{ category: 'switch', sku: 'S', qty: -1 }]), /qty/);
  assert.throws(() => countManagedDevices([{ category: 'access_point', sku: 'A', qty: 1.5 }]), /qty/);
});

// ---------------------------------------------------------------------------------------------
// Subtask 2: integratedControllerCheck (AC1)
// ---------------------------------------------------------------------------------------------

test('AC1: a gateway with controller in capabilities returns true and raises CONTROLLER_CAPACITY_NOT_VERIFIED', () => {
  const ctx = createCtx();
  assert.equal(integratedControllerCheck(integratedGateway('ER-INT'), ctx), true);
  assert.equal(ctx.flags.length, 1);
  assert.equal(ctx.flags[0].code, 'CONTROLLER_CAPACITY_NOT_VERIFIED');
  assert.match(ctx.flags[0].message, /ER-INT/);
  assert.match(ctx.flags[0].message, /limits were not checked/);
});

test('AC1: controller_type integrated is also a marker', () => {
  const ctx = createCtx();
  assert.equal(integratedControllerCheck(gateway('G', { controller_type: 'integrated' }), ctx), true);
  assert.equal(ctx.flags[0].code, 'CONTROLLER_CAPACITY_NOT_VERIFIED');
});

test('AC1: a gateway without the marker returns false and raises nothing', () => {
  const ctx = createCtx();
  assert.equal(integratedControllerCheck(gateway('G'), ctx), false);
  assert.equal(integratedControllerCheck(gateway('G', { capabilities: ['router', 'switch'] }), ctx), false);
  assert.deepEqual(ctx.flags, []);
  assert.deepEqual(ctx.unmet, []);
});

test('AC1: without counts the limits cannot be checked, even when the row states them', () => {
  const ctx = createCtx();
  const row = integratedGateway('G', { max_managed_aps: 5, max_managed_switches: 5, max_managed_gateways: 1 });
  assert.equal(integratedControllerCheck(row, ctx), true);
  assert.equal(ctx.flags[0].code, 'CONTROLLER_CAPACITY_NOT_VERIFIED');
});

test('AC1: a built-in controller whose stated limits fit is verified: true, nothing raised', () => {
  const ctx = createCtx();
  const row = integratedGateway('G', { max_managed_aps: 10, max_managed_switches: 5, max_managed_gateways: 1, max_managed_aps_and_switches: 15 });
  assert.equal(integratedControllerCheck(row, ctx, counts(10, 5, 1)), true);   // every limit exactly met
  assert.deepEqual(ctx.flags, []);
});

test('AC1: a built-in controller whose stated limits are exceeded returns false and raises CONTROLLER_INTEGRATED_CAPACITY_EXCEEDED', () => {
  const row = integratedGateway('G', { max_managed_aps: 10, max_managed_switches: 5, max_managed_gateways: 1 });
  [counts(11, 5, 1), counts(10, 6, 1), counts(10, 5, 2)].forEach((c) => {
    const ctx = createCtx();
    assert.equal(integratedControllerCheck(row, ctx, c), false);
    assert.equal(ctx.flags.length, 1);
    assert.equal(ctx.flags[0].code, 'CONTROLLER_INTEGRATED_CAPACITY_EXCEEDED');
    assert.match(ctx.flags[0].message, /G/);
  });
});

test('AC1: the combined cap of a built-in controller is checked', () => {
  const ctx = createCtx();
  const row = integratedGateway('G', {
    max_managed_aps: 20, max_managed_switches: 20, max_managed_gateways: 1, max_managed_aps_and_switches: 22,
  });
  assert.equal(integratedControllerCheck(row, ctx, counts(12, 11, 1)), false);   // 23 > 22
  assert.match(ctx.flags[0].message, /APs and switches combined/);
});

test('AC1: with some per-type limits missing the check cannot run: true and not verified', () => {
  const ctx = createCtx();
  const row = integratedGateway('G', { max_managed_aps: 10 });
  assert.equal(integratedControllerCheck(row, ctx, counts(99, 99, 9)), true);
  assert.equal(ctx.flags[0].code, 'CONTROLLER_CAPACITY_NOT_VERIFIED');
});

test('integratedControllerCheck rejects a missing row or ctx', () => {
  assert.throws(() => integratedControllerCheck(null, createCtx()), TypeError);
  assert.throws(() => integratedControllerCheck(gateway('G'), null), TypeError);
});

// ---------------------------------------------------------------------------------------------
// Subtask 3: candidates (AC2)
// ---------------------------------------------------------------------------------------------

test('AC2: only controller rows of the plan vendor with type hardware, software or cloud are candidates', () => {
  const catalog = [
    controller('HW'),
    controller('SW', { controller_type: 'software' }),
    controller('CL', { controller_type: 'cloud' }),
    controller('INT', { controller_type: 'integrated' }),
    controller('OTHER', { vendor: 'W' }),
    integratedGateway('GW-WITH-CTRL'),
    gateway('GW'),
    accessPoint('AP'),
  ];
  const skus = collectControllerCandidates(catalog, 'V').map((row) => row.sku).sort();
  assert.deepEqual(skus, ['CL', 'HW', 'SW']);
});

test('AC2: a row with an unknown or missing controller_type is not a candidate', () => {
  const catalog = [controller('X', { controller_type: undefined }), controller('Y', { controller_type: 'appliance' })];
  assert.deepEqual(collectControllerCandidates(catalog, 'V'), []);
});

test('AC2: status is normalized (lifecycle_status fallback, upper case)', () => {
  const row = controller('C', {});
  delete row.status;
  row.lifecycle_status = 'sunsetting';
  assert.equal(collectControllerCandidates([row], 'V')[0].status, 'SUNSETTING');
});

test('AC2: a DISCONTINUED controller is never selected', () => {
  const catalog = [controller('GONE', { status: 'DISCONTINUED', price: 1 }), controller('OK', { price: 900 })];
  assert.equal(picked('CE', counts(5, 2, 1), catalog), 'OK');
  assert.equal(picked('HP', counts(5, 2, 1), catalog), 'OK');
});

test('AC2: a SUNSETTING controller may be selected and raises a flag asking to confirm availability', () => {
  const { result, ctx } = select('CE', counts(5, 2, 1), [controller('OLD', { status: 'SUNSETTING' })]);
  assert.equal(result.ok, true);
  assert.equal(result.sku.sku, 'OLD');
  assert.equal(result.flags.length, 1);
  assert.equal(result.flags[0].code, FLAG_CODES.SUNSETTING);
  assert.match(result.flags[0].message, /OLD/);
  assert.match(result.flags[0].message, /confirm availability/);
  assert.deepEqual(ctx.flags, result.flags);
});

test('AC2: an ACTIVE controller raises no sunsetting flag', () => {
  const { result, ctx } = select('CE', counts(5, 2, 1), [controller('NEW')]);
  assert.deepEqual(result.flags, []);
  assert.deepEqual(ctx.flags, []);
});

test('AC2: software and cloud controllers are selectable', () => {
  assert.equal(picked('CE', counts(5, 2, 1), [controller('SW', { controller_type: 'software' })]), 'SW');
  assert.equal(picked('CE', counts(5, 2, 1), [controller('CL', { controller_type: 'cloud' })]), 'CL');
});

// ---------------------------------------------------------------------------------------------
// Subtask 4: fit (AC3, AC4)
// ---------------------------------------------------------------------------------------------

test('AC3: every comparison is inclusive; one more of any type does not fit', () => {
  const row = controller('C', { max_managed_aps: 10, max_managed_switches: 5, max_managed_gateways: 2 });
  assert.equal(controllerFits(row, counts(10, 5, 2)), true);
  assert.equal(controllerFits(row, counts(11, 5, 2)), false);
  assert.equal(controllerFits(row, counts(10, 6, 2)), false);
  assert.equal(controllerFits(row, counts(10, 5, 3)), false);
  assert.equal(controllerFits(row, counts(0, 0, 0)), true);
});

test('AC3: the combined cap is applied when present (aps + switches)', () => {
  const row = controller('C', { max_managed_aps: 50, max_managed_switches: 50, max_managed_gateways: 2, max_managed_aps_and_switches: 22 });
  assert.equal(controllerFits(row, counts(12, 10, 1)), true);    // 22 <= 22
  assert.equal(controllerFits(row, counts(12, 11, 1)), false);   // 23 > 22
});

test('AC3: an absent combined cap is not applied', () => {
  const row = controller('C', { max_managed_aps: 50, max_managed_switches: 50, max_managed_gateways: 2 });
  assert.equal(controllerFits(row, counts(50, 50, 2)), true);
});

test('AC3: a row without a per-type limit never fits (it cannot be checked)', () => {
  const row = controller('C');
  delete row.max_managed_switches;
  assert.equal(controllerFits(row, counts(1, 1, 1)), false);
});

test('AC3: selection skips candidates the counts exceed', () => {
  const catalog = [
    controller('SMALL', { price: 500, max_managed_aps: 10 }),
    controller('BIG', { price: 2000, max_managed_aps: 50 }),
  ];
  assert.equal(picked('CE', counts(30, 2, 1), catalog), 'BIG');
});

test('AC4: gateways 2 does not fit a controller that manages only 1 gateway', () => {
  const catalog = [
    controller('ONE-GW', { price: 500, max_managed_gateways: 1 }),
    controller('TWO-GW', { price: 2000, max_managed_gateways: 2 }),
  ];
  assert.equal(picked('CE', counts(5, 2, 2), catalog), 'TWO-GW');
  assert.equal(picked('CE', counts(5, 2, 1), catalog), 'ONE-GW');
  const { result } = select('CE', counts(5, 2, 2), [catalog[0]]);
  assert.equal(result.ok, false);
  assert.match(result.unmet.reason, /gateways/);
});

// ---------------------------------------------------------------------------------------------
// Subtask 5: Cost-Efficient (AC5)
// ---------------------------------------------------------------------------------------------

test('AC5: CE picks the lowest-priced fitting candidate with qty 1', () => {
  const catalog = [controller('C-MID', { price: 2000 }), controller('C-LOW', { price: 800 }), controller('C-HIGH', { price: 5000 })];
  const { result } = select('CE', counts(5, 2, 1), catalog);
  assert.equal(result.ok, true);
  assert.equal(result.sku.sku, 'C-LOW');
  assert.equal(result.qty, 1);
});

test('AC5: a tie on price is broken by SKU ascending, whatever the catalog order', () => {
  const a = controller('CT-A', { price: 1000 });
  const b = controller('CT-B', { price: 1000 });
  assert.equal(picked('CE', counts(5, 2, 1), [b, a]), 'CT-A');
  assert.equal(picked('CE', counts(5, 2, 1), [a, b]), 'CT-A');
});

test('AC5: a null price is excluded from the ranking and the exclusion is flagged', () => {
  const catalog = [controller('NO-PRICE', { price: null }), controller('PRICED', { price: 3000 })];
  const { result, ctx } = select('CE', counts(5, 2, 1), catalog);
  assert.equal(result.sku.sku, 'PRICED');
  assert.deepEqual(result.flags.map((flag) => flag.code), ['UNPRICED_SKUS_EXCLUDED']);
  assert.deepEqual(ctx.flags, result.flags);
});

test('AC5: a price of 0 is a real price and wins', () => {
  assert.equal(picked('CE', counts(5, 2, 1), [controller('PAID', { price: 1000 }), controller('FREE', { price: 0 })]), 'FREE');
});

test('AC5: only fitting candidates are ranked (a cheaper one that does not fit loses)', () => {
  const catalog = [controller('CHEAP-SMALL', { price: 100, max_managed_aps: 1 }), controller('DEAR-BIG', { price: 9000 })];
  assert.equal(picked('CE', counts(10, 2, 1), catalog), 'DEAR-BIG');
});

// ---------------------------------------------------------------------------------------------
// Subtask 6: High-Performance (AC6)
// ---------------------------------------------------------------------------------------------

// counts 10 APs, 4 switches, 1 gateway. Headroom = smallest of limit / count - 1 over APs, switches, gateways.
const hp = (sku, aps, switches, price, extra = {}) =>
  controller(sku, { max_managed_aps: aps, max_managed_switches: switches, max_managed_gateways: 100, price, ...extra });
const HP_COUNTS = counts(10, 4, 1);
const A = hp('HP-A', 10, 4, 1000);    // headroom 0%
const B = hp('HP-B', 13, 5, 2000);    // min(30%, 25%) = 25%
const C = hp('HP-C', 13, 6, 3000);    // min(30%, 50%) = 30%, exactly on the bound
const D = hp('HP-D', 20, 8, 4000);    // 100%
const E = hp('HP-E', 30, 12, 5000);   // 200%

test('AC6: HP picks the highest headroom within the bound; a candidate exactly on the bound is within', () => {
  assert.equal(picked('HP', HP_COUNTS, [A, B, C, D, E]), 'HP-C');
});

test('AC6: HP result has qty 1 and is the CE choice only by coincidence', () => {
  const { result } = select('HP', HP_COUNTS, [A, B, C, D]);
  assert.equal(result.qty, 1);
  assert.equal(picked('CE', HP_COUNTS, [A, B, C, D]), 'HP-A');
  assert.notEqual(result.sku.sku, 'HP-A');
});

test('AC6: removing the best candidate moves HP to the next one within the bound', () => {
  assert.equal(picked('HP', HP_COUNTS, [A, B, D, E]), 'HP-B');
  assert.equal(picked('HP', HP_COUNTS, [A, D, E]), 'HP-A');
});

test('AC6: a candidate with 0% headroom (an exact fit) is within the bound', () => {
  assert.equal(picked('HP', HP_COUNTS, [A]), 'HP-A');
});

test('AC6: when none is within the bound the fitting candidate with the smallest headroom is chosen', () => {
  assert.equal(picked('HP', HP_COUNTS, [E, D]), 'HP-D');
  assert.equal(picked('HP', HP_COUNTS, [D, E]), 'HP-D');
});

test('AC6: ties on headroom are broken by price ascending, then SKU', () => {
  const c = counts(12, 4, 1);                          // 15 / 12 and 5 / 4 are both 25%
  const dear = hp('X-DEAR', 15, 5, 2000);
  const cheap = hp('Y-CHEAP', 15, 5, 1500);
  assert.equal(picked('HP', c, [dear, cheap]), 'Y-CHEAP');
  const t1 = hp('T-1', 15, 5, 1500);
  const t2 = hp('T-2', 15, 5, 1500);
  assert.equal(picked('HP', c, [t2, t1]), 'T-1');
});

test('AC6: a null price does not disqualify a candidate in HP', () => {
  const nullPriced = hp('NULL-PRICE', 13, 6, null);   // 30%, the best headroom
  const { result } = select('HP', HP_COUNTS, [A, B, nullPriced]);
  assert.equal(result.ok, true);
  assert.equal(result.sku.sku, 'NULL-PRICE');
  assert.equal(result.sku.price, null);
});

test('AC6: on equal headroom a priced candidate beats an unpriced one', () => {
  const c = counts(12, 4, 1);
  assert.equal(picked('HP', c, [hp('A-NULL', 15, 5, null), hp('B-PRICED', 15, 5, 9999)]), 'B-PRICED');
});

test('AC6: the combined cap counts in the headroom', () => {
  const c = counts(10, 10, 1);
  const capped = controller('CAPPED', { max_managed_aps: 100, max_managed_switches: 100, max_managed_gateways: 100, max_managed_aps_and_switches: 22, price: 1000 });   // 22 / 20 = 10%
  const roomy = controller('ROOMY', { max_managed_aps: 12, max_managed_switches: 12, max_managed_gateways: 100, price: 2000 });                                          // 20%
  assert.equal(picked('HP', c, [capped, roomy]), 'ROOMY');
  const huge = controller('HUGE', { max_managed_aps: 100, max_managed_switches: 100, max_managed_gateways: 100, price: 500 });                                           // 900%
  assert.equal(picked('HP', c, [capped, huge]), 'CAPPED');    // without the cap's headroom the 900% one would look best
});

test('AC6: a dimension whose count is 0 is left out of the headroom', () => {
  const c = counts(0, 4, 1);
  const noAps = hp('NO-APS', 0, 5, 1000);       // 25% on switches; a 0 / 0 AP ratio must not poison it
  const bigAps = hp('BIG-APS', 50, 4, 500);     // 0%
  assert.equal(picked('HP', c, [bigAps, noAps]), 'NO-APS');
});

test('AC6: with every count at 0 there is nothing to manage, so the cheapest fitting candidate is chosen', () => {
  const c = counts(0, 0, 0);
  assert.equal(picked('HP', c, [controller('DEAR', { price: 3000 }), controller('CHEAP', { price: 1000 })]), 'CHEAP');
});

test('AC6: HP uses params.HP_HEADROOM_MAX, not a number of its own', () => {
  // The bound is 0.30: 13 / 10 is on it, 14 / 10 is over it.
  const over = hp('OVER', 14, 6, 100);
  assert.equal(picked('HP', HP_COUNTS, [over, A]), 'HP-A');
  assert.equal(picked('HP', HP_COUNTS, [over]), 'OVER');
});

// ---------------------------------------------------------------------------------------------
// Subtask 7: unmet outcomes (AC7)
// ---------------------------------------------------------------------------------------------

const assertUnmet = (result, ctx, reasonPattern) => {
  assert.equal(result.ok, false);
  assert.equal(result.unmet.category, 'controller');
  assert.equal(result.unmet.vendor, 'V');
  assert.match(result.unmet.reason, reasonPattern);
  assert.deepEqual(ctx.unmet, [result.unmet]);      // addUnmet was called, exactly once
  assert.equal(validateSelectionResult(result), true);
};

test('AC7: a vendor with no controller row is unmet', () => {
  [[], [controller('OTHER', { vendor: 'W' })], [gateway('GW')]].forEach((catalog) => {
    ['CE', 'HP'].forEach((plan) => {
      const { result, ctx } = select(plan, counts(5, 2, 1), catalog);
      assertUnmet(result, ctx, /No controller in the catalog for V/);
    });
  });
});

test('AC7: a vendor with only integrated controller rows says they are not purchasable', () => {
  const { result, ctx } = select('CE', counts(5, 2, 1), [controller('INT', { controller_type: 'integrated' })]);
  assertUnmet(result, ctx, /not separately purchasable/);
});

test('AC7: a vendor whose controllers are all DISCONTINUED is unmet', () => {
  const { result, ctx } = select('CE', counts(5, 2, 1), [controller('GONE', { status: 'DISCONTINUED' })]);
  assertUnmet(result, ctx, /^No purchasable/);
});

test('AC7: no row fits: the reason names the closest controller, its limit and what the plan needs', () => {
  const catalog = [controller('C-20', { max_managed_aps: 20 }), controller('C-30', { max_managed_aps: 30 })];
  const { result, ctx } = select('CE', counts(40, 2, 1), catalog);
  assertUnmet(result, ctx, /manages up to 30 APs, plan needs 40/);
  assert.match(result.unmet.reason, /C-30/);
});

test('AC7: the no-fit reason covers switches, gateways and the combined cap', () => {
  const sw = select('CE', counts(1, 11, 1), [controller('C')]);
  assert.match(sw.result.unmet.reason, /manages up to 10 switches, plan needs 11/);
  const gw = select('HP', counts(1, 1, 3), [controller('C')]);
  assert.match(gw.result.unmet.reason, /manages up to 2 gateways, plan needs 3/);
  const cap = select('CE', counts(12, 11, 1), [controller('C', { max_managed_aps: 50, max_managed_switches: 50, max_managed_aps_and_switches: 22 })]);
  assert.match(cap.result.unmet.reason, /manages up to 22 APs and switches combined, plan needs 23/);
});

test('AC7: CE with only unpriced fitting rows is unmet and says they have no price', () => {
  const { result, ctx } = select('CE', counts(5, 2, 1), [controller('N1', { price: null }), controller('N2', { price: null })]);
  assertUnmet(result, ctx, /have no price/);
});

test('AC7: the same unpriced rows are fine for HP', () => {
  const { result } = select('HP', counts(5, 2, 1), [controller('N1', { price: null })]);
  assert.equal(result.ok, true);
});

test('AC7: unmet outcomes never throw; both result shapes pass validateSelectionResult', () => {
  const ok = select('CE', counts(5, 2, 1), [controller('C')]).result;
  assert.equal(validateSelectionResult(ok), true);
  assert.doesNotThrow(() => select('HP', counts(500, 2, 1), [controller('C')]));
});

test('AC7: a result with ok true always carries a SKU object', () => {
  ['CE', 'HP'].forEach((plan) => {
    const { result } = select(plan, counts(5, 2, 1), [controller('C')]);
    assert.equal(result.ok, true);
    assert.equal(typeof result.sku, 'object');
    assert.equal(result.sku.sku, 'C');
  });
});

test('selectController throws on programmer errors', () => {
  const c = counts(1, 1, 1);
  const cat = [controller('C')];
  assert.throws(() => selectController('', 'CE', c, cat, createCtx()), TypeError);
  assert.throws(() => selectController('V', 'cost_efficient', c, cat, createCtx()), /CE or HP/);
  assert.throws(() => selectController('V', 'CE', { aps: 1 }, cat, createCtx()), /counts/);
  assert.throws(() => selectController('V', 'CE', counts(1.5, 1, 1), cat, createCtx()), /counts/);
  assert.throws(() => selectController('V', 'CE', c, 'x', createCtx()), /catalog/);
  assert.throws(() => selectController('V', 'CE', c, cat, null), /ctx/);
});

// ---------------------------------------------------------------------------------------------
// AC9: pure and deterministic
// ---------------------------------------------------------------------------------------------

const MIXED_CATALOG = [
  controller('M-1', { price: 1500 }),
  controller('M-2', { price: 1500, status: 'SUNSETTING' }),
  controller('M-3', { price: null, max_managed_aps: 40 }),
  controller('M-4', { price: 900, max_managed_aps: 12, max_managed_switches: 4 }),
  controller('M-5', { price: 2500, max_managed_aps: 13, max_managed_switches: 5 }),
];

test('AC9: identical inputs give identical SKU, quantity, flags and unmet entries', () => {
  const c = counts(10, 4, 1);
  const catalog = deepFreeze(clone(MIXED_CATALOG));
  const frozen = deepFreeze({ ...c });
  ['CE', 'HP'].forEach((plan) => {
    const runs = Array.from({ length: 3 }, () => select(plan, frozen, catalog));
    runs.slice(1).forEach((run) => {
      assert.deepEqual(run.result, runs[0].result);
      assert.deepEqual(run.ctx, runs[0].ctx);
    });
  });
  // unmet entries too
  const noFit = Array.from({ length: 2 }, () => select('CE', counts(900, 4, 1), catalog));
  assert.deepEqual(noFit[0], noFit[1]);
});

test('AC9: the result does not depend on the order of the catalog', () => {
  const c = counts(10, 4, 1);
  ['CE', 'HP'].forEach((plan) => {
    const forward = select(plan, c, MIXED_CATALOG);
    const reversed = select(plan, c, [...MIXED_CATALOG].reverse());
    assert.deepEqual(reversed.result, forward.result);
  });
});

test('AC9: inputs are not mutated', () => {
  const catalog = deepFreeze(clone(MIXED_CATALOG));
  assert.doesNotThrow(() => select('HP', deepFreeze(counts(10, 4, 1)), catalog));
  assert.doesNotThrow(() => select('CE', deepFreeze(counts(10, 4, 1)), catalog));
  assert.doesNotThrow(() => countManagedDevices(deepFreeze(items(3, 2, 1))));
  assert.doesNotThrow(() => integratedControllerCheck(deepFreeze(integratedGateway('G')), createCtx()));
});