'use strict';

// NWP-ENGINE-019 AC3 (6E fallback), AC4 (Sunsetting notices) and AC5 (redundant core).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildVendorPlansAssembled, finishEngineResult,
} = require('../../src/types/engine/orchestration.js');
const { createCtx } = require('../../src/types/engine/ctx.js');
const { finalizeEngineResult } = require('../../src/types/engine/steps/assemble.js');
const {
  build, run, row, gateway, accessPoint, accessPoint6E, switchSku, BASIC, VENDOR,
  itemsOf, flagsOf,
} = require('./helpers/nwp019-fixtures.js');

const sum = (list) => list.reduce((total, value) => total + value, 0);

// 440 Wi-Fi devices with video conferencing: 6E sizing is 8 APs, Wi-Fi 6 sizing is 11.
const crowdedVideo = (config) => {
  config.preferences.applications.videoConferencing = true;
  config.devices.wifiDevices = 440;
  config.devices.wiredComputers = 0;
  config.physicalSpace.floorAreaPerFloor = 140;
};
const smallSwitches = () => [
  gateway('GW1', 5000, 1), accessPoint('AP1', 4000, 1),
  switchSku('SW8', 3000, 1, 8), switchSku('SW10', 3500, 1, 10),
];

test('AC3: every part of a fallback plan uses the Wi-Fi 6 counts', () => {
  const { ce, requirements } = run(crowdedVideo, smallSwitches());
  assert.equal(requirements.wireless.CE.total, 8);
  assert.deepEqual(ce.wireless, { standard: '6', requestedStandard: '6E', total: 11, perFloor: [11] });
  assert.equal(itemsOf(ce, 'access_point')[0].qty, 11);
  assert.equal(ce.poeBudget.perFloor[0].loadW, 11 * 15);
  const poePorts = sum(itemsOf(ce, 'switch').map((item) => item.qty * (item.sku === 'SW8' ? 8 : 10)));
  assert.ok(poePorts >= 11, `only ${poePorts} PoE ports for 11 access points`);
  const apNode = ce.topology.nodes.find((node) => node.role === 'access_point');
  assert.equal(apNode.qty, 11);
  assert.equal(sum(apNode.placements.map((placement) => placement.qty)), 11);
  assert.equal(flagsOf(ce, 'TOPOLOGY_ATTACHMENT_OVERFLOW').length, 0);
});

test('AC3: a successful fallback leaves no unmet requirement or incomplete-plan warning', () => {
  const { ce, hp, result } = run(crowdedVideo, smallSwitches());
  for (const plan of [ce, hp]) {
    assert.equal(plan.complete, true);
    assert.deepEqual(plan.unmet, []);
    assert.equal(plan.bom.totalIsPartial, false);
    assert.equal(flagsOf(plan, 'WIFI_6E_FALLBACK').length, 1);
    assert.equal(flagsOf(plan, 'BOM_PLAN_INCOMPLETE').length, 0);
    assert.ok(!plan.limitations.some((line) => line.startsWith('Requirement not met')));
    assert.equal(plan.ledger.filter((entry) => entry.field === 'wireless.planStandard').length, 1);
    assert.ok(!plan.ledger.some((entry) => entry.field === 'wireless.standard' && entry.valueUsed === '6'));
  }
  assert.deepEqual(result.unmet, []);
});

test('AC3: with no AP of either generation, the plan reports the AP once as unmet', () => {
  const { ce } = run(crowdedVideo, smallSwitches().filter((sku) => sku.category !== 'access_point'));
  assert.equal(ce.complete, false);
  assert.equal(ce.unmet.filter((entry) => entry.category === 'access_point').length, 1);
  assert.equal(ce.wireless, undefined);
  assert.equal(flagsOf(ce, 'WIFI_6E_FALLBACK').length, 0);
});

test('AC3: a vendor with a 6E AP keeps 6E sizing, and another vendor does not affect it', () => {
  const other = (sku) => ({ ...sku, vendor: 'W' });
  const setup = build(crowdedVideo, [
    ...smallSwitches(),
    other(gateway('W-GW', 5000, 1)), other(accessPoint6E('W-AP', 7000, 1)), other(switchSku('W-SW', 9000, 1, 24)),
  ]);
  const plansFor = (name) => buildVendorPlansAssembled({
    vendor: { ...VENDOR, name }, input: setup.input, requirements: setup.requirements,
    catalog: setup.catalog, sharedLedger: setup.ctx.ledger,
  });
  const [wCe] = plansFor('W');
  assert.equal(wCe.wireless.standard, '6E');
  assert.equal(wCe.wireless.total, 8);
  assert.equal(flagsOf(wCe, 'WIFI_6E_FALLBACK').length, 0);
});

test('AC3: per-vendor stages with a JSON round trip match the single-process result and validate', () => {
  const single = run(crowdedVideo, smallSwitches());
  const staged = build(crowdedVideo, smallSwitches());
  const roundTrip = (value) => JSON.parse(JSON.stringify(value));
  const plans = roundTrip(buildVendorPlansAssembled({
    vendor: VENDOR, input: roundTrip(staged.input), requirements: roundTrip(staged.requirements),
    catalog: roundTrip(staged.catalog), sharedLedger: roundTrip(staged.ctx.ledger),
  }));
  const merged = finishEngineResult({
    input: staged.input, requirements: staged.requirements, vendors: [VENDOR], plans, sharedCtx: staged.ctx,
  });
  assert.deepEqual(roundTrip(merged), roundTrip(single.result));
  assert.doesNotThrow(() => finalizeEngineResult(merged, '2026-11-27T00:00:00.000Z'));
});

test('AC4: every selected Sunsetting SKU gets exactly one notice naming it', () => {
  const sunsetting = BASIC().map((sku) => ({ ...sku, status: 'SUNSETTING' }));
  const { ce, hp } = run(undefined, sunsetting);
  for (const plan of [ce, hp]) {
    const messages = flagsOf(plan, 'SKU_SUNSETTING').map((flag) => flag.message);
    assert.equal(messages.length, 3);
    for (const sku of ['GW1', 'AP1', 'SW24']) {
      assert.equal(messages.filter((message) => message.startsWith(`${sku} `)).length, 1);
    }
    assert.ok(messages.every((message) => /confirm availability .* before purchase/.test(message)));
  }
});

test('AC4: one notice when the same SKU is both core and access switch', () => {
  const catalog = BASIC().map((sku) => (sku.sku === 'SW24' ? { ...sku, status: 'SUNSETTING' } : sku));
  const { ce } = run((config) => { config.physicalSpace.numberOfFloors = 3; }, catalog);
  assert.equal(flagsOf(ce, 'SKU_SUNSETTING').length, 1);
});

test('AC4: a Sunsetting enclosure is flagged, and Active devices are not', () => {
  const { ce } = run();
  assert.equal(flagsOf(ce, 'SKU_SUNSETTING').length, 0);
  const setup = build();
  const catalog = setup.catalog.map((sku) => (sku.category === 'enclosure' ? { ...sku, status: 'SUNSETTING' } : sku));
  const [plan] = buildVendorPlansAssembled({
    vendor: VENDOR, input: setup.input, requirements: setup.requirements, catalog, sharedLedger: [],
  });
  const enclosureSku = itemsOf(plan, 'enclosure')[0].sku;
  assert.deepEqual(flagsOf(plan, 'SKU_SUNSETTING').map((flag) => flag.message.split(' ')[0]), [enclosureSku]);
});

test('AC4: a Sunsetting controller is announced once, not twice', () => {
  const controller = row({
    sku: 'OC-OLD', category: 'controller', controller_type: 'hardware', price: 5000, status: 'SUNSETTING',
    max_managed_devices: 100, max_managed_aps: 100, max_managed_switches: 100, max_managed_gateways: 100,
    rack_units: 0,
  });
  const setup = build(undefined, [...BASIC(), controller]);
  const [plan] = buildVendorPlansAssembled({
    vendor: { ...VENDOR, needController: true }, input: setup.input, requirements: setup.requirements,
    catalog: setup.catalog, sharedLedger: [],
  });
  assert.equal(itemsOf(plan, 'controller')[0]?.sku, 'OC-OLD');
  const mentions = plan.flags.filter((flag) => /SUNSETTING/.test(flag.code) && flag.message.includes('OC-OLD'));
  assert.deepEqual(mentions.map((flag) => flag.code), ['SKU_SUNSETTING']);
});

const everyMinute = (config) => { config.internet.downtimeImpact = 'every_minute_matters'; };
const corePairRow = (plan) => plan.configurationPlan.sections
  .find((section) => section.id === 'redundancy').rows
  .find((entry) => entry.setting === 'Core switch redundancy');

test('AC5: one floor with "every minute matters" gets two core-serving switches everywhere', () => {
  // 3U switches, so the second unit is large enough to change the enclosure.
  const tallSwitch = BASIC().map((sku) => (sku.category === 'switch' ? { ...sku, rack_units: 3 } : sku));
  const baseline = run(undefined, tallSwitch);
  const { ce, hp } = run(everyMinute, tallSwitch);
  for (const plan of [ce, hp]) {
    assert.deepEqual(itemsOf(plan, 'switch').map((item) => item.qty), [2]);
    assert.equal(plan.bom.lines.find((line) => line.category === 'switch').qty, 2);
    assert.equal(plan.topology.nodes.filter((node) => node.role === 'switch' && node.layer === 'core').length, 2);
    assert.equal(corePairRow(plan).value, 'Redundant core switch pair');
    assert.equal(flagsOf(plan, 'EDGE_DEVICES_SINGLE_HOMED').length, 1);
  }
  assert.deepEqual(itemsOf(baseline.ce, 'switch').map((item) => item.qty), [1]);
  const rackSize = (plan) => Number(itemsOf(plan, 'enclosure')[0].sku.split('-')[1]);
  assert.ok(rackSize(ce) > rackSize(baseline.ce), `${rackSize(ce)}U is not larger than ${rackSize(baseline.ce)}U`);
});

test('AC5: the second unit counts in the CE total-cost comparison', () => {
  // One SW48 would be cheaper than two SW24, but a pair is required, so two SW24 beat two SW48.
  const { ce } = run((config) => { everyMinute(config); config.devices.wiredComputers = 30; }, [
    gateway('GW1', 5000, 1), accessPoint('AP1', 4000, 1),
    switchSku('SW24', 9000, 1, 24), switchSku('SW48', 16000, 1, 48),
  ]);
  assert.deepEqual(itemsOf(ce, 'switch').map(({ sku, qty }) => [sku, qty]), [['SW24', 2]]);
});

test('AC5: a plan with an unmet switch does not claim a redundant core', () => {
  const { ce } = run(everyMinute, BASIC().filter((sku) => sku.category !== 'switch'));
  assert.equal(ce.complete, false);
  assert.match(corePairRow(ce).value, /not included/);
});

test('AC5: a multi-floor site keeps a separate core pair', () => {
  const { ce } = run((config) => { everyMinute(config); config.physicalSpace.numberOfFloors = 2; });
  const [core, ...access] = itemsOf(ce, 'switch');
  assert.equal(core.qty, 2);
  assert.equal(core.floor, undefined);
  assert.deepEqual(access.map((item) => item.qty), [1, 1]);
  assert.equal(corePairRow(ce).value, 'Redundant core switch pair');
});
