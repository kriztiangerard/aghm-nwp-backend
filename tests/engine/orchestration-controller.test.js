'use strict';
// NWP-ENGINE-018 wiring: the controller step inside buildPlan (orchestration.js).
//
// The neighbouring engine steps (gateway, APs, PoE, switches, enclosure, power, optics, BOM, assembly, lifecycle,
// default vendor) are replaced by stubs in require.cache before orchestration.js is loaded, so this file tests only
// the controller step and how its result reaches plan.items, plan.unmet, plan.flags and plan.complete.
// The controller module, select.js, ctx.js, params.js and contracts.js are the real ones.
// node:test runs each test file in its own process, so the stubs do not leak into other test files.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..', '..', 'src', 'types', 'engine');
const stub = (relative, exports) => {
  const filename = require.resolve(path.join(ENGINE, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const ENCLOSURE = { sku: 'ENC', vendor: 'V' };
stub('devices/gateway.js', { selectGateway: () => { throw new Error('stubbed per test'); } });
stub('devices/aps.js', { selectAccessPoints: () => { throw new Error('stubbed per test'); } });
stub('devices/poe.js', { computePoeBudget: () => ({ perFloor: [{ budgetW: 10 }] }) });
stub('devices/switches.js', { selectSwitches: () => { throw new Error('stubbed per test'); } });
stub('devices/enclosure.js', {
  computeRequiredRackUnits: () => ({ requiredU: 0 }),
  resolveHousingType: () => 'closet',
  chooseEnclosure: () => ({ ok: true, sku: ENCLOSURE, qty: 0, flags: [] }),
});
stub('devices/power.js', { buildPowerProtection: () => ({}) });
stub('devices/optics.js', { planOptics: () => null });
stub('bom.js', { buildBom: () => { throw new Error('not used'); }, buildInstallationMaterials: () => ({}) });
stub('steps/assemble.js', { assemblePlan: (plan) => plan, combineAssembledPlans: () => ({}) });
stub('lifecycle.js', { noCurrentModelUnmet: (category, vendor) => ({ unmet: { category, vendor, reason: 'no current model' } }) });
stub('default-vendor.js', { selectDefaultVendors: () => ({ CE: null, HP: null }) });

const { buildPlan } = require('../../src/types/engine/orchestration.js');
const { createCtx } = require('../../src/types/engine/ctx.js');
const controllerStep = require('../../src/types/engine/devices/controller.js');
const { controller, gateway, accessPoint, switchRow, integratedGateway, counts } = require('../fixtures/e18-fixtures.js');

const VENDOR = { name: 'V', needController: true, managementModes: ['dashboard'] };
const AP = accessPoint('AP');
const SW = switchRow('SW');

// Builds the stub steps for a plan with `aps` APs, `switches` switches in total (one core, the rest access) and a gateway.
function stepsFor({ gatewayRow, gatewayQty = 1, aps = 12, switches = 4, controllerStepOverride }) {
  return {
    selectGateway: () => ({ ok: true, sku: gatewayRow, qty: gatewayQty, flags: [] }),
    selectAccessPoints: () => ({ ok: true, sku: AP, qty: aps, flags: [] }),
    computePoeBudget: () => ({ perFloor: [{ budgetW: 10 }] }),
    selectSwitches: () => ({
      ok: true,
      accessSwitches: [{ floor: 1, sku: SW, qty: switches - 1, uplinksPerSwitch: 1, flags: [] }],
      coreSwitch: { sku: SW, qty: 1, flags: [] },
      coreSwitchQuantity: 1,
      uplinksPerFloor: 1,
      flags: [],
    }),
    ...(controllerStepOverride ? { controller: controllerStepOverride } : {}),
  };
}

const run = (options, catalog, { vendor = VENDOR, planType = 'CE' } = {}) => {
  const ctx = createCtx();
  const plan = buildPlan(vendor, planType, { wireless: {} }, { housing: 'closet' }, catalog, ctx, stepsFor(options));
  return { plan, ctx };
};

const controllerItems = (plan) => plan.items.filter((item) => item.category === 'controller');

test('AC8: a selected controller joins plan.items as {category, sku, qty: 1}, after the gateway, APs and switches', () => {
  const { plan } = run({ gatewayRow: gateway('GW') }, [controller('CTL-CHEAP', { price: 900 }), controller('CTL-DEAR', { price: 4000 })]);
  assert.deepEqual(controllerItems(plan), [{ category: 'controller', sku: 'CTL-CHEAP', qty: 1 }]);
  assert.deepEqual(plan.items.map((item) => item.category), ['gateway', 'access_point', 'switch', 'switch', 'controller']);
  assert.equal(plan.complete, true);
  assert.deepEqual(plan.unmet, []);
});

test('AC8: the High-Performance plan uses the HP pick', () => {
  const catalog = [
    controller('CTL-TIGHT', { price: 900, max_managed_aps: 12, max_managed_switches: 4, max_managed_gateways: 1 }),
    controller('CTL-ROOMY', { price: 1500, max_managed_aps: 15, max_managed_switches: 5, max_managed_gateways: 2 }),
    controller('CTL-HUGE', { price: 6000, max_managed_aps: 100, max_managed_switches: 50, max_managed_gateways: 5 }),
  ];
  assert.equal(controllerItems(run({ gatewayRow: gateway('GW') }, catalog, { planType: 'CE' }).plan)[0].sku, 'CTL-TIGHT');
  assert.equal(controllerItems(run({ gatewayRow: gateway('GW') }, catalog, { planType: 'HP' }).plan)[0].sku, 'CTL-ROOMY');
});

test('the counts passed to the controller step are the plan items: APs, switches (core and access) and gateways', () => {
  const calls = {};
  const spy = {
    countManagedDevices: (items) => { calls.counts = controllerStep.countManagedDevices(items); return calls.counts; },
    integratedControllerCheck: (row, ctx, given) => { calls.checkCounts = given; return false; },
    selectController: (vendor, planType, given, catalog, ctx) => { calls.selectCounts = given; return controllerStep.selectController(vendor, planType, given, catalog, ctx); },
  };
  run({ gatewayRow: gateway('GW'), aps: 12, switches: 4, controllerStepOverride: spy }, [controller('C')]);
  assert.deepEqual(calls.counts, counts(12, 4, 1));
  assert.deepEqual(calls.checkCounts, counts(12, 4, 1));
  assert.deepEqual(calls.selectCounts, counts(12, 4, 1));
});

test('AC4: an HA gateway pair (qty 2) counts as 2 gateways, so a one-gateway controller is skipped', () => {
  const catalog = [
    controller('ONE-GW', { price: 500, max_managed_gateways: 1 }),
    controller('TWO-GW', { price: 2000, max_managed_gateways: 2 }),
  ];
  const { plan } = run({ gatewayRow: gateway('GW'), gatewayQty: 2 }, catalog);
  assert.equal(controllerItems(plan)[0].sku, 'TWO-GW');
});

test('AC1: a gateway with a built-in controller adds no controller item and raises the not-verified flag', () => {
  const { plan } = run({ gatewayRow: integratedGateway('ER-INT') }, [controller('SPARE')]);
  assert.deepEqual(controllerItems(plan), []);
  assert.deepEqual(plan.flags.map((flag) => flag.code), ['CONTROLLER_CAPACITY_NOT_VERIFIED']);
  assert.equal(plan.complete, true);
});

test('AC1: a built-in controller whose stated limits fit adds no controller item and raises no flag', () => {
  const row = integratedGateway('ER-INT', { max_managed_aps: 12, max_managed_switches: 4, max_managed_gateways: 1 });
  const { plan } = run({ gatewayRow: row }, []);
  assert.deepEqual(controllerItems(plan), []);
  assert.deepEqual(plan.flags, []);
  assert.equal(plan.complete, true);
});

test('AC1: a built-in controller whose stated limits are exceeded falls back to a standalone controller', () => {
  const row = integratedGateway('ER-INT', { max_managed_aps: 10, max_managed_switches: 4, max_managed_gateways: 1 });
  const { plan } = run({ gatewayRow: row }, [controller('BACKUP', { price: 1200 })]);
  assert.deepEqual(controllerItems(plan), [{ category: 'controller', sku: 'BACKUP', qty: 1 }]);
  assert.deepEqual(plan.flags.map((flag) => flag.code), ['CONTROLLER_INTEGRATED_CAPACITY_EXCEEDED']);
  assert.equal(plan.complete, true);
});

test('AC7: no controller fits: the plan is incomplete, the unmet entry is recorded once, and generation continues', () => {
  const { plan } = run({ gatewayRow: gateway('GW'), aps: 40 }, [controller('SMALL')]);
  assert.deepEqual(controllerItems(plan), []);
  assert.equal(plan.complete, false);
  const unmet = plan.unmet.filter((item) => item.category === 'controller');
  assert.equal(unmet.length, 1);
  assert.equal(unmet[0].vendor, 'V');
  assert.match(unmet[0].reason, /manages up to 20 APs, plan needs 40/);
  assert.ok(plan.items.some((item) => item.category === 'switch'), 'later steps still ran');
});

test('AC7: a vendor with no controller row at all is unmet and the plan is incomplete', () => {
  const { plan } = run({ gatewayRow: gateway('GW') }, []);
  assert.equal(plan.complete, false);
  assert.match(plan.unmet.find((item) => item.category === 'controller').reason, /No controller in the catalog for V/);
});

test('a vendor that does not need a controller never runs the controller step', () => {
  const vendor = { name: 'V', needController: false, managementModes: ['cli'] };
  const { plan } = run({ gatewayRow: gateway('GW') }, [], { vendor });
  assert.deepEqual(controllerItems(plan), []);
  assert.equal(plan.complete, true);
  assert.deepEqual(plan.unmet, []);
  assert.deepEqual(plan.flags, []);
});