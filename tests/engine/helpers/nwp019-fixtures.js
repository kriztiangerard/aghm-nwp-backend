'use strict';

// Shared fixtures for the NWP-ENGINE-019 suites. The questionnaire answers go through the real
// normalize -> requirements -> engine chain. All catalog rows and prices are made up.

const ENGINE = '../../../src/types/engine';
const { createCtx } = require(`${ENGINE}/ctx.js`);
const { normalize } = require(`${ENGINE}/normalize.js`);
const { normalizeRequestAnswers } = require(`${ENGINE}/network-config.js`);
const network = require(`${ENGINE}/requirements/network.js`);
const { wirelessRequirements } = require(`${ENGINE}/requirements/wireless.js`);
const connectivity = require(`${ENGINE}/requirements/connectivity.js`);
const devices = require(`${ENGINE}/requirements/devices.js`);
const power = require(`${ENGINE}/devices/power.js`);
const { runEngine } = require(`${ENGINE}/orchestration.js`);

const APPS = ['videoConferencing', 'voipCalls', 'posPayment', 'cloudStorage', 'businessSoftware',
  'videoStreaming', 'securityCameraViewing', 'basicBrowsingEmail'];

function answers() {
  return {
    project: { name: 'x', numberOfSites: 1, totalUsers: 40 },
    physicalSpace: { numberOfFloors: 1, floorAreaPerFloor: 200, roomsPerFloor: 5,
      largeGroupRooms: { hasLargeGroupRooms: false, rooms: [] } },
    existingNetwork: { equipmentStatus: 'none', existingCabling: 'none_or_not_sure' },
    internet: { currentSpeedMbps: 100, connectionType: 'fiber', downtimeImpact: 'can_wait' },
    devices: { wiredComputers: 10, wifiDevices: 40, voip: { enabled: false },
      ipCameras: { enabled: false }, otherNetworkDevices: { enabled: false } },
    preferences: { guestWifi: false, sensitiveData: 'no',
      applications: Object.fromEntries(APPS.map((app) => [app, false])),
      equipmentLocation: 'not_sure', managementPreference: 'not_sure' },
    businessContext: { monthlyITBudget: 'under_15000', ITSupport: 'none',
      electricityReliability: 'stable', expectedGrowth: false },
  };
}

const row = (fields) => ({
  vendor: 'V', currency: 'PHP', status: 'ACTIVE', name: fields.sku, price_source: 'manual',
  is_stale: false, price_updated_at: '2026-11-20T00:00:00Z', ...fields,
});
const gateway = (sku, price, rank, extra = {}) => row({
  sku, price, line: `G${rank}`, line_rank: rank, category: 'gateway', routing_throughput_mbps: 2000,
  site_to_site_vpn: true, max_vpn_tunnels: 10, dual_wan: true, ha_capability: true, rack_units: 1, ...extra,
});
const accessPoint = (sku, price, rank, extra = {}) => row({
  sku, price, line: `A${rank}`, line_rank: rank, category: 'access_point', wifi_gen: 6,
  poe_standard: 'at', max_draw_w: 15, ...extra,
});
const accessPoint6E = (sku, price, rank, extra = {}) =>
  accessPoint(sku, price, rank, { wifi_gen: 6, supported_6ghz: true, ...extra });
const switchSku = (sku, price, rank, ports, extra = {}) => row({
  sku, price, line: `S${rank}`, line_rank: rank, category: 'switch', copper_ports: ports, sfp_ports: 4,
  sfp_form_factor: 'SFP+', poe_ports: ports, poe_budget_w: ports * 30, poe_standard: 'at',
  rack_units: 1, ...extra,
});
const enclosure = (units, price, formFactor) => row({
  sku: `${formFactor}-${units}`, vendor: 'Generic', category: 'enclosure', form_factor: formFactor,
  rack_units: units, price,
});

const ENCLOSURES = [
  enclosure(6, 3000, 'wall'), enclosure(9, 5000, 'wall'), enclosure(24, 9000, 'wall'),
  enclosure(12, 7000, 'rack'), enclosure(42, 20000, 'rack'),
];
const BASIC = () => [gateway('GW1', 5000, 1), accessPoint('AP1', 4000, 1), switchSku('SW24', 9000, 1, 24)];
const VENDOR = { name: 'V', needController: false, managementModes: ['dashboard'] };

function build(mutate, catalogRows = BASIC()) {
  const config = answers();
  if (mutate) mutate(config);
  const ctx = createCtx();
  const input = normalize(normalizeRequestAnswers(config), ctx);
  const needs = network.deriveNetworkRequirements(input, ctx);
  const requirements = {
    ...needs,
    wireless: wirelessRequirements(input, ctx),
    ...connectivity.deriveConnectivityRequirements(input, needs, ctx),
    ...devices.deriveDeviceRequirements(input, ctx),
    ...power.recommendPower({ input }),
  };
  return { input, requirements, ctx, catalog: [...catalogRows, ...ENCLOSURES], vendors: [VENDOR] };
}

function run(mutate, catalogRows) {
  const setup = build(mutate, catalogRows);
  const result = runEngine(setup.input, setup.requirements, setup.catalog, setup.vendors, undefined, setup.ctx);
  const [ce, hp] = result.plans;
  return { ...setup, result, ce, hp };
}

const itemsOf = (plan, category) => plan.items.filter((item) => item.category === category);
const skuOf = (plan, category) => itemsOf(plan, category)[0]?.sku;
const flagsOf = (plan, code) => plan.flags.filter((flag) => flag.code === code);

module.exports = {
  build, run, row, gateway, accessPoint, accessPoint6E, switchSku, BASIC, VENDOR,
  itemsOf, skuOf, flagsOf,
};
