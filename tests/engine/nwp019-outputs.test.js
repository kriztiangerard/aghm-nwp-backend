'use strict';

// NWP-ENGINE-019 AC6 (topology floors), AC7 (optics), AC9 (BOM limitation) and AC10 (single enclosure).
// AC8 is display-only and is covered in the frontend repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATIC_LIMITATIONS } = require('../../src/types/engine/steps/limitations.js');
const { countUplinkLinks } = require('../../src/types/engine/devices/optics.js');
const { run, switchSku, BASIC, itemsOf } = require('./helpers/nwp019-fixtures.js');

const threeFloorsBigRoomOnTop = (config) => {
  config.physicalSpace.numberOfFloors = 3;
  config.physicalSpace.largeGroupRooms = { hasLargeGroupRooms: true, rooms: [{ floor: 3, capacity: 150 }] };
  config.devices.wifiDevices = 170;
  config.devices.wiredComputers = 30;
};

const floorsOf = (node) => node.placements.map((placement) => [placement.floorLabel, placement.qty]);

test('AC6: access switches are drawn on their sizing floor and the core on Floor 1', () => {
  const { ce } = run(threeFloorsBigRoomOnTop);
  const nodes = ce.topology.nodes.filter((node) => node.role === 'switch');
  assert.deepEqual(floorsOf(nodes.find((node) => node.layer === 'core')), [['Floor 1', 1]]);
  const accessFloors = nodes.filter((node) => node.layer === 'access').map((node) => floorsOf(node)[0][0]);
  const expected = itemsOf(ce, 'switch').slice(1)
    .flatMap((item) => Array(item.qty).fill(`Floor ${item.floor}`));
  assert.deepEqual(accessFloors, expected);
  assert.equal(ce.ledger.filter((entry) => entry.field === 'topology.coreFloor').length, 1);
});

test('AC6: AP placement matches the per-floor counts the plan used', () => {
  const { ce, hp } = run(threeFloorsBigRoomOnTop);
  for (const plan of [ce, hp]) {
    const node = plan.topology.nodes.find((candidate) => candidate.role === 'access_point');
    assert.deepEqual(node.placements.map((placement) => placement.qty), plan.wireless.perFloor);
  }
  assert.ok(ce.wireless.perFloor[2] > ce.wireless.perFloor[0], 'fixture should be uneven');
});

test('AC6: node and edge ids are stable between runs', () => {
  const ids = () => {
    const { topology } = run(threeFloorsBigRoomOnTop).ce;
    return [...topology.nodes, ...topology.edges].map((entry) => entry.id);
  };
  assert.deepEqual(ids(), ids());
});

const twoFloorsManyPcs = (config) => {
  config.physicalSpace.numberOfFloors = 2;
  config.devices.wiredComputers = 60;
};
const fiberUplinks = (plan) => {
  const layerOf = new Map(plan.topology.nodes.map((node) => [node.id, node.layer]));
  return plan.topology.edges.filter((edge) => edge.medium === 'fiber' && layerOf.get(edge.target) === 'access');
};

test('AC7: links are counted per access switch uplink and match the topology', () => {
  const { ce } = run(twoFloorsManyPcs);
  const accessUnits = itemsOf(ce, 'switch').slice(1).reduce((total, item) => total + item.qty, 0);
  assert.ok(accessUnits > 2, 'fixture should need more than one switch per floor');
  assert.equal(ce.optics.links, accessUnits);
  assert.equal(ce.optics.modules, accessUnits * 2);
  assert.equal(fiberUplinks(ce).length, ce.optics.links);
});

test('AC7: redundant uplinks double the links, matching the paths to both cores', () => {
  const { ce } = run((config) => {
    twoFloorsManyPcs(config);
    config.internet.downtimeImpact = 'every_minute_matters';
  });
  const accessUnits = itemsOf(ce, 'switch').slice(1).reduce((total, item) => total + item.qty, 0);
  assert.equal(ce.optics.links, accessUnits * 2);
  assert.equal(fiberUplinks(ce).length, ce.optics.links);
});

test('AC7: a single floor with existing fiber keeps the per-floor rule', () => {
  const { ce } = run((config) => { config.existingNetwork.existingCabling = 'fiber'; });
  assert.equal(ce.optics.links, 1);
  assert.equal(countUplinkLinks({ accessSwitches: [{ qty: 3, uplinksPerSwitch: 0 }] }), null);
});

test('AC7: SFP is price on request, with no BOM line, and an unknown form factor is not guessed', () => {
  const noFormFactor = [
    ...BASIC().filter((sku) => sku.category !== 'switch'),
    switchSku('SW24', 9000, 1, 24, { sfp_form_factor: undefined }),
  ];
  const { ce } = run(twoFloorsManyPcs, noFormFactor);
  const sfp = ce.installationMaterials.items.find((item) => item.item === 'sfp_modules');
  assert.equal(sfp.priceDisplay, 'price on request');
  assert.equal(sfp.formFactor, 'form factor not determined');
  assert.equal(sfp.modules, ce.optics.modules);
  assert.ok(!ce.bom.lines.some((line) => /sfp|optic/i.test(`${line.category} ${line.sku}`)));
});

test('AC9: the BOM limitation uses the approved wording', () => {
  assert.equal(STATIC_LIMITATIONS[1],
    'The Bill of Materials covers major network equipment only (gateways/routers, switches, wireless access points, controllers where applicable, and racks or enclosures). Firewall functions are provided by the gateway and appear as a logical node in the topology. No separate firewall appliance is included or priced. It excludes cabling, cable accessories and other minor installation materials, and actual quantities must be determined through a physical site survey and detailed deployment planning.');
});

test('AC8 (engine side): no firewall BOM line is created', () => {
  assert.ok(!run().ce.bom.lines.some((line) => /firewall/i.test(line.category)));
});

const enclosureNotice = (plan) => plan.limitations.filter((line) => /separate floor network closets/.test(line));

test('AC10: a multi-floor plan with an enclosure discloses the single enclosure once', () => {
  const { ce } = run((config) => { config.physicalSpace.numberOfFloors = 2; });
  assert.equal(enclosureNotice(ce).length, 1);
  assert.match(enclosureNotice(ce)[0], /total rack units.*site survey/);
});

test('AC10: a single-floor plan has no enclosure notice', () => {
  assert.equal(enclosureNotice(run().ce).length, 0);
});
