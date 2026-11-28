'use strict';
// Shared fixtures for the NWP-ENGINE-018 tests. Plain data only; nothing here touches a database.
// Every row passes validateCatalogSku() (the tests check this), so they match what the engine receives.

const clone = (value) => JSON.parse(JSON.stringify(value));

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

// A controller row. Defaults: ACTIVE hardware controller of vendor 'V', priced 1000, 20 APs / 10 switches / 2 gateways.
const controller = (sku, overrides = {}) => ({
  sku,
  vendor: 'V',
  name: `Controller ${sku}`,
  category: 'controller',
  status: 'ACTIVE',
  price: 1000,
  currency: 'PHP',
  controller_type: 'hardware',
  max_managed_aps: 20,
  max_managed_switches: 10,
  max_managed_gateways: 2,
  ...overrides,
});

const gateway = (sku, overrides = {}) => ({
  sku,
  vendor: 'V',
  name: `Gateway ${sku}`,
  category: 'gateway',
  line: 'Entry',
  line_rank: 1,
  status: 'ACTIVE',
  price: 5000,
  currency: 'PHP',
  copper_ports: 8,
  ...overrides,
});

const accessPoint = (sku, overrides = {}) => ({
  sku,
  vendor: 'V',
  name: `AP ${sku}`,
  category: 'access_point',
  line: 'Entry',
  line_rank: 1,
  status: 'ACTIVE',
  price: 3000,
  currency: 'PHP',
  ...overrides,
});

const switchRow = (sku, overrides = {}) => ({
  sku,
  vendor: 'V',
  name: `Switch ${sku}`,
  category: 'switch',
  line: 'Entry',
  line_rank: 1,
  status: 'ACTIVE',
  price: 4000,
  currency: 'PHP',
  ...overrides,
});

// Gateway with a built-in controller (the ER7212PC pattern): marked by capabilities, limits on the row.
const integratedGateway = (sku, overrides = {}) => gateway(sku, { capabilities: ['router', 'switch', 'controller'], ...overrides });

const counts = (aps, switches, gateways) => ({ aps, switches, gateways });

// plan.items as the orchestrator builds them
const items = (aps, switches, gateways) => [
  { category: 'gateway', sku: 'GW', qty: gateways },
  { category: 'access_point', sku: 'AP', qty: aps },
  { category: 'switch', sku: 'SW', qty: switches },
];

module.exports = { clone, deepFreeze, controller, gateway, accessPoint, switchRow, integratedGateway, counts, items };