'use strict';

const { createCtx } = require('./ctx');
const { normalize } = require('./normalize');
const { normalizeRequestAnswers } = require('./network-config');
const { deriveNetworkRequirements } = require('./requirements/network');
const { wirelessRequirements } = require('./requirements/wireless');
const { deriveConnectivityRequirements } = require('./requirements/connectivity');
const { deriveDeviceRequirements } = require('./requirements/devices');
const { recommendPower } = require('./devices/power');
const { runEngine } = require('./orchestration');
const { loadEngineData, loadVendors } = require('./catalog-repository');
const { validateRequirements, validateNormalizedInput } = require('./contracts');

function deriveRequirements(payload) {
  const ctx = createCtx();
  const input = normalize(normalizeRequestAnswers(payload), ctx);
  const network = deriveNetworkRequirements(input, ctx);
  const wireless = wirelessRequirements(input, ctx);
  const connectivity = deriveConnectivityRequirements(input, network, ctx);
  const devices = deriveDeviceRequirements(input, ctx);
  const requirements = {
    ...network, wireless, ...connectivity, ...devices,
    ...recommendPower({ input }),
  };
  validateRequirements(requirements);
  return { input, requirements, ctx };
}

// Entry-Lambda stage: everything that can reject a request, plus the vendor list. No catalog.
async function prepare(payload, dependencies = {}) {
  const { input, requirements, ctx } = deriveRequirements(payload);
  validateNormalizedInput(input);
  const vendors = await (dependencies.loadVendors || loadVendors)();
  const now = new Date(dependencies.now ?? Date.now()).toISOString();
  return { input, requirements, vendors, ctx, now };
}

// Single-process path: local runs, existing tests, and the parity check.
async function run(payload, dependencies = {}) {
  const { input, requirements, ctx } = deriveRequirements(payload);
  const engineData = await (dependencies.loadEngineData || loadEngineData)({
    now: dependencies.now ?? new Date(),
  });
  return runEngine(input, requirements, engineData.catalog, engineData.vendors, undefined, ctx);
}

module.exports = { run, prepare };