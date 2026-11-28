'use strict';

// NWP-ENGINE-019 AC1 (CE total cost) and AC2 (HP starts from the CE pick).

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectSku, pickHighPerformance } = require('../../src/types/engine/select.js');
const { createCtx } = require('../../src/types/engine/ctx.js');
const {
  run, gateway, accessPoint, switchSku, BASIC, itemsOf, skuOf,
} = require('./helpers/nwp019-fixtures.js');

const manyWiredPcs = (config) => { config.devices.wiredComputers = 60; };
const switchCatalog = (...switches) => [gateway('GW1', 5000, 1), accessPoint('AP1', 4000, 1), ...switches];

const pick = (pool, extra = {}) => selectSku({
  pool: pool.map((sku) => ({ status: 'ACTIVE', ...sku })),
  predicate: () => true, plan: 'cost_efficient', category: 'switch', vendor: 'V', ctx: createCtx(), ...extra,
}).sku.sku;

test('AC1: CE takes the lowest price x quantity, not the lowest unit price', () => {
  const { ce } = run(manyWiredPcs, switchCatalog(
    switchSku('SW8', 5000, 1, 8), switchSku('SW48', 12000, 1, 48, { poe_budget_w: 600 }),
    switchSku('SW24', 9000, 1, 24),
  ));
  assert.deepEqual(itemsOf(ce, 'switch').map(({ sku, qty }) => [sku, qty]), [['SW48', 2]]);
  assert.equal(ce.bom.lines.find((line) => line.sku === 'SW48').lineTotal, 24000);
});

test('AC1: a cheap model still wins when it is also cheapest in total', () => {
  const { ce } = run(manyWiredPcs, switchCatalog(
    switchSku('SW8', 2000, 1, 8), switchSku('SW48', 12000, 1, 48, { poe_budget_w: 600 }),
  ));
  // One copper port per unit is kept for the gateway link, so 9 small units still cost less than 2 large ones.
  assert.deepEqual(itemsOf(ce, 'switch').map(({ sku, qty }) => [sku, qty]), [['SW8', 9]]);
});

test('AC1: equal totals break on unit price, then SKU id', () => {
  const units = { cheap: 4, dear: 1, a: 2, b: 2 };
  const costOf = (sku) => sku.price * units[sku.key];
  assert.equal(pick([{ sku: 'X', price: 400, key: 'dear' }, { sku: 'Y', price: 100, key: 'cheap' }], { costOf }), 'Y');
  assert.equal(pick([{ sku: 'B', price: 200, key: 'b' }, { sku: 'A', price: 200, key: 'a' }], { costOf }), 'A');
});

test('AC1: without a cost function, selection still ranks by unit price', () => {
  assert.equal(pick([{ sku: 'B', price: 200 }, { sku: 'A', price: 300 }]), 'B');
});

test('AC1: unpriced and Discontinued switches are still excluded', () => {
  const { ce } = run(manyWiredPcs, switchCatalog(
    switchSku('NOPRICE', null, 1, 48), switchSku('OLD', 1, 1, 48, { status: 'DISCONTINUED' }),
    switchSku('SW24', 9000, 1, 24),
  ));
  assert.equal(skuOf(ce, 'switch'), 'SW24');
});

test('AC2: the next line is ranked by total cost when a cost function is given', () => {
  const priced = [
    { sku: 'S', price: 5000, line_rank: 2 }, { sku: 'L', price: 12000, line_rank: 2 },
  ];
  const costOf = (sku) => sku.price * (sku.sku === 'S' ? 6 : 2);
  assert.equal(pickHighPerformance(priced, { line_rank: 1 }, costOf).sku, 'L');
});

const hpNeedsTwoTunnels = (config) => {
  config.project.numberOfSites = 2;
  config.businessContext.expectedGrowth = true;
  config.businessContext.growth = { headcountGrowth: '0_10', newSites: 'one' };
};

test('AC2: HP gateway is the next line above the CE gateway', () => {
  const { ce, hp, requirements } = run(hpNeedsTwoTunnels, [
    gateway('GW-L1', 5000, 1, { max_vpn_tunnels: 1 }), gateway('GW-L2', 8000, 2), gateway('GW-L3', 20000, 3),
    accessPoint('AP1', 4000, 1), switchSku('SW24', 9000, 1, 24),
  ]);
  assert.deepEqual(requirements.vpnTunnelsNeeded, { CE: 1, HP: 2 });
  assert.equal(skuOf(ce, 'gateway'), 'GW-L1');
  assert.equal(skuOf(hp, 'gateway'), 'GW-L2');
});

const heavyGrowth = (config) => {
  config.devices.wifiDevices = 20;
  config.devices.wiredComputers = 20;
  config.businessContext.expectedGrowth = true;
  config.businessContext.growth = { headcountGrowth: '31_plus', newSites: 'none' };
};

test('AC2: HP steps up from the CE switch, which is not always the cheapest unit', () => {
  // By total cost CE takes two line 2 switches over six line 1 switches, so HP must move on to line 3.
  // Stepping up from the cheapest unit (line 1) would hand HP the same line 2 switch as CE.
  const { ce, hp } = run(manyWiredPcs, switchCatalog(
    switchSku('SW-L1', 5000, 1, 8), switchSku('SW-L2', 12000, 2, 48, { poe_budget_w: 600 }),
    switchSku('SW-L3', 20000, 3, 48, { poe_budget_w: 600 }),
  ));
  assert.equal(skuOf(ce, 'switch'), 'SW-L2');
  assert.equal(skuOf(hp, 'switch'), 'SW-L3');
});

test('AC2: HP access switch is the next line above the CE switch line', () => {
  const { ce, hp } = run(heavyGrowth, switchCatalog(
    switchSku('SW-L1', 9000, 1, 24), switchSku('SW-L2', 15000, 2, 48), switchSku('SW-L3', 30000, 3, 48),
  ));
  assert.equal(skuOf(ce, 'switch'), 'SW-L1');
  assert.equal(skuOf(hp, 'switch'), 'SW-L2');
});

test('AC2: each floor and the core step up from their own CE picks', () => {
  const { ce, hp } = run((config) => {
    config.physicalSpace.numberOfFloors = 2;
    config.devices.wiredComputers = 20;
  }, [
    ...BASIC().filter((sku) => sku.category !== 'switch'),
    switchSku('SW-L1', 9000, 1, 24), switchSku('SW-L2', 15000, 2, 24), switchSku('SW-L3', 30000, 3, 24),
  ]);
  assert.deepEqual(itemsOf(ce, 'switch').map((item) => [item.sku, item.floor]),
    [['SW-L1', undefined], ['SW-L1', 1], ['SW-L1', 2]]);
  assert.deepEqual(itemsOf(hp, 'switch').map((item) => [item.sku, item.floor]),
    [['SW-L2', undefined], ['SW-L2', 1], ['SW-L2', 2]]);
});

test('AC2: HP AP is the next line above the CE AP', () => {
  const { ce, hp } = run(undefined, [
    gateway('GW1', 5000, 1), switchSku('SW24', 9000, 1, 24),
    accessPoint('AP-L1', 4000, 1), accessPoint('AP-L2', 6000, 2), accessPoint('AP-L3', 9000, 3),
  ]);
  assert.deepEqual([skuOf(ce, 'access_point'), skuOf(hp, 'access_point')], ['AP-L1', 'AP-L2']);
});

test('AC2: with nothing above the CE line, HP stays in that line', () => {
  const { hp } = run();
  assert.deepEqual([skuOf(hp, 'gateway'), skuOf(hp, 'access_point'), skuOf(hp, 'switch')],
    ['GW1', 'AP1', 'SW24']);
});

test('AC2: a category CE could not fill does not break HP', () => {
  // No gateway in the catalog: both plans report it as unmet, and the other categories still select.
  const { ce, hp } = run(undefined, [
    accessPoint('AP1', 4000, 1), switchSku('SW24', 9000, 1, 24),
  ]);
  assert.equal(skuOf(ce, 'gateway'), undefined);
  assert.equal(skuOf(hp, 'gateway'), undefined);
  assert.equal(skuOf(hp, 'access_point'), 'AP1');
});

test('the same input run twice gives identical plans', () => {
  assert.deepEqual(run(heavyGrowth).result, run(heavyGrowth).result);
});
