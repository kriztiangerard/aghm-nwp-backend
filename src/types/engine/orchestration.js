'use strict';

// NWP-ENGINE-015: Vendor x plan orchestration.
// This module coordinates existing engine steps; it does not implement their algorithms.

const {
  CONTRACT_VERSION,
  ValidationError,
  validateNormalizedInput,
  validateRequirements,
  validateCatalogSku,
  validateVendorDescriptors,
  validateBom,
} = require('./contracts');
const { createCtx, addLedger, addFlag } = require('./ctx');
const { assemblePlan, combineAssembledPlans } = require('./steps/assemble');
const { noCurrentModelUnmet } = require('./lifecycle');

const { selectGateway } = require('./devices/gateway');
const { selectAccessPoints } = require('./devices/aps');
const { computePoeBudget } = require('./devices/poe');
const { selectSwitches } = require('./devices/switches');
const { selectDefaultVendors } = require('./default-vendor.js');
const controllerStep = require('./devices/controller');

const {
  computeRequiredRackUnits,
  resolveHousingType,
  chooseEnclosure,
} = require('./devices/enclosure');

const { buildPowerProtection } = require('./devices/power');
const { planOptics } = require('./devices/optics');
const { buildBom, buildInstallationMaterials } = require('./bom');

const DEFAULT_STEPS = Object.freeze({
  selectGateway,
  selectAccessPoints,
  computePoeBudget,
  selectSwitches,
  buildBom,
  buildInstallationMaterials,
});

function getPlanRequirements(reqs, planType) {
  if (planType !== 'CE' && planType !== 'HP') {
    throw new Error(`Unknown plan type '${planType}'`);
  }

  return {
    ...reqs,
    wireless: reqs.wireless,
    vpnTunnelsNeeded: reqs.vpnTunnelsNeeded,
  };
}

const PLAN_TYPES = Object.freeze([
  { planType: 'CE', selectorPlan: 'cost_efficient' },
  { planType: 'HP', selectorPlan: 'high_performance' },
]);

const BOM_FLAG_CODES = Object.freeze({
  PARTIAL_PRICE: 'BOM_PARTIAL_PRICE',
  PLAN_INCOMPLETE: 'BOM_PLAN_INCOMPLETE',
  PRICE_STALE: 'BOM_PRICE_STALE',
});

// NWP-ENGINE-016 AC10: the result must not hold full catalog rows. Selector results (switchSelection,
// enclosureSelection) are kept on the plan, but every embedded SKU object is replaced by its SKU string.
function toPublicSelection(value) {
  if (Array.isArray(value)) return value.map(toPublicSelection);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === 'sku' && entry && typeof entry === 'object' ? entry.sku : toPublicSelection(entry),
      ]),
    );
  }
  return value;
}

function appendUnique(list, extra) {
  const seen = new Set(list.map((entry) => JSON.stringify(entry)));
  return [...list, ...extra.filter((entry) => !seen.has(JSON.stringify(entry)))];
}

function validateEngineInputs(input, reqs, catalog, vendors) {
  validateNormalizedInput(input);
  validateRequirements(reqs);

if (!Array.isArray(catalog)) {
  throw new ValidationError('catalog', 'Must be an array.');
}

  catalog.forEach((sku, index) => {
    try {
      validateCatalogSku(sku);
    } catch (error) {
      error.message = `catalog[${index}]: ${error.message}`;
      throw error;
    }
  });

  validateVendorDescriptors(vendors);

  const genericName = require('./params').GENERIC_VENDOR_NAME;

  vendors.forEach((vendor) => {
    if (vendor.name === genericName) {
  throw new ValidationError(
    'vendors',
    `Vendor '${genericName}' is reserved for generic infrastructure and cannot have plans.`,
  );
}

  });

  return { genericName };
}

function createEmptyPlan(vendor, planType, catalog) {
  const ctx = createCtx();

  return {
    vendor: vendor.name,
    planType,
    complete: false,
    items: [],
    bom: {
      currency: catalog[0]?.currency || 'PHP',
      lines: [],
      total: null,
      totalIsPartial: true,
    },
    unmet: ctx.unmet,
    flags: ctx.flags,
    ledger: ctx.ledger,
  };
}

function recordUnmetIfMissing(ctx, unmet, vendor, catalog) {
  const hasCurrentModel = catalog.some(
    (sku) =>
      sku.vendor === vendor &&
      sku.category === unmet.category &&
      ['ACTIVE', 'SUNSETTING'].includes(sku.status),
  );
  const isMissingCurrentModel =
    unmet.category !== 'enclosure' &&
    !hasCurrentModel &&
    unmet.reason.startsWith('No purchasable');
  const vendorUnmet = isMissingCurrentModel
    ? noCurrentModelUnmet(unmet.category, vendor).unmet
    : { ...unmet, vendor };

  const existingIndex = ctx.unmet.findIndex(
    (item) =>
      item.category === vendorUnmet.category &&
      item.vendor === vendorUnmet.vendor,
  );

  if (existingIndex === -1) ctx.unmet.push(vendorUnmet);
  else ctx.unmet[existingIndex] = vendorUnmet;
  return vendorUnmet;
}

function assertSelectedVendor(selection, vendor, category) {
  if (!selection?.ok || !selection.sku) {
    return;
  }

  const selectedVendor = selection.sku.vendor;

  // Generic is allowed only for enclosure selection.
  if (
    selectedVendor === vendor.name ||
    (category === 'enclosure' && selectedVendor === require('./params').GENERIC_VENDOR_NAME)
  ) {
    return;
  }

  const error = new Error(
    `NWP-ENGINE-015 vendor consistency defect: ` +
    `${vendor.name} plan selected ${selectedVendor} ` +
    `${category} SKU ${selection.sku.sku}.`,
  );

  error.name = 'OrchestrationDefect';
  throw error;
}

const SUNSETTING_FLAG_CODE = 'SKU_SUNSETTING';

function flagSunsettingSelections(ctx, selections) {
  const noticed = new Set();
  for (const { sku } of selections) {
    if (sku.status !== 'SUNSETTING' || noticed.has(sku.sku)) continue;
    noticed.add(sku.sku);

    // The controller selector raises its own notice; this one replaces it so the SKU is announced once.
    const duplicate = ctx.flags.findIndex(
      (flag) => flag.code === controllerStep.FLAG_CODES.SUNSETTING && flag.message.includes(sku.sku),
    );
    if (duplicate !== -1) ctx.flags.splice(duplicate, 1);

    addFlag(
      ctx,
      SUNSETTING_FLAG_CODE,
      `${sku.sku} is sunsetting; confirm availability with the vendor or distributor before purchase.`,
    );
  }
}

// NWP-ENGINE-019 AC2: the full catalog rows behind the Cost-Efficient plan's picks. This has to run before
// toPublicPlan, which strips switch rows down to SKU strings.
function collectCePicks(plan, vendorName, catalog) {
  const rowFor = (category) => {
    const item = plan.items.find((candidate) => candidate.category === category);
    if (!item) return undefined;
    return catalog.find(
      (row) =>
        row.vendor === vendorName &&
        row.sku === item.sku &&
        (row.category === category || (category === 'access_point' && row.category === 'ap')),
    );
  };

  return {
    gateway: rowFor('gateway'),
    accessPoint: rowFor('access_point'),
    switches: plan.switchSelection?.ok === true
      ? {
          accessSwitches: plan.switchSelection.accessSwitches,
          coreSwitch: plan.switchSelection.coreSwitch ?? null,
        }
      : undefined,
  };
}

function buildPlan(vendor, planType, reqs, input, catalog, ctx, steps = {}) {
  const selectorPlan = planType === 'CE'
    ? 'cost_efficient'
    : planType === 'HP'
      ? 'high_performance'
      : null;

  if (!selectorPlan) {
    throw new Error(`Unknown plan type '${planType}'`);
  }

  if (!ctx || !Array.isArray(ctx.ledger)
      || !Array.isArray(ctx.flags) || !Array.isArray(ctx.unmet)) {
    throw new TypeError('buildPlan requires a context from createCtx()');
  }

  // The orchestration layer receives selector implementations as dependencies.
  // This keeps the call order testable without hiding unfinished selector errors.
  if (typeof steps.selectGateway !== 'function') {
    throw new Error('buildPlan requires steps.selectGateway');
  }

  const plan = {
    vendor: vendor.name,
    planType,
    complete: true,
    items: [],
    bom: {
      currency: catalog[0]?.currency || 'PHP',
      lines: [],
      total: null,
      totalIsPartial: true,
    },
    unmet: ctx.unmet,
    flags: ctx.flags,
    ledger: ctx.ledger,
  };

  let planRequirements = getPlanRequirements(reqs, planType);
  const selectedDeviceItems = [];
  // NWP-ENGINE-019 AC2: for HP, the Cost-Efficient SKU already chosen in each category ({gateway,
  // accessPoint, switches}). A category CE could not fill stays undefined, so HP uses its own fallback.
  const cePicks = planType === 'HP' ? steps.cePicks ?? {} : {};

    const gatewayResult = steps.selectGateway({
    catalog,
    vendor: vendor.name,
    requirements: planRequirements,
    plan: selectorPlan,
    cePick: cePicks.gateway,
    ctx,
  });

  const { validateSelectionResult } = require('./contracts');
  validateSelectionResult(gatewayResult);
  assertSelectedVendor(gatewayResult, vendor, 'gateway');

  if (gatewayResult.ok) {
    plan.items.push({
      category: 'gateway',
      sku: gatewayResult.sku.sku,
      qty: gatewayResult.qty,
    });
      selectedDeviceItems.push({
    sku: gatewayResult.sku,
    qty: gatewayResult.qty,
  });
  } else {
    recordUnmetIfMissing(ctx, gatewayResult.unmet, vendor.name, catalog);
    plan.complete = false;
  }

  let apResult = null;

  // AP selection is optional until the caller supplies the selector.
  // This preserves existing gateway-only orchestration tests.
  if (typeof steps.selectAccessPoints === 'function') {
    apResult = steps.selectAccessPoints({
      catalog,
      vendor: vendor.name,
      requirements: planRequirements,
      plan: planType,
      cePick: cePicks.accessPoint,
      ctx,
      input,
    });

    validateSelectionResult(apResult);
    assertSelectedVendor(apResult, vendor, 'access_point');

    if (apResult.ok) {
      // NWP-ENGINE-019 AC3: PoE, switching, topology and the output all use the sizing the AP selection
      // actually used, which differs from the shared requirement after a Wi-Fi 6E fallback.
      const wireless = apResult.wireless ?? planRequirements.wireless;
      const sizing = wireless?.[planType];
      if (sizing && Array.isArray(sizing.perFloor)) {
        planRequirements = { ...planRequirements, wireless };
        plan.wireless = {
          standard: wireless.standard,
          requestedStandard: reqs.wireless?.standard ?? wireless.standard,
          total: sizing.total,
          perFloor: [...sizing.perFloor],
        };
      }

      plan.items.push({
        category: 'access_point',
        sku: apResult.sku.sku,
        qty: apResult.qty,
      });
        selectedDeviceItems.push({
    sku: apResult.sku,
    qty: apResult.qty,
  });
    } else {
      recordUnmetIfMissing(ctx, apResult.unmet, vendor.name, catalog);
      plan.complete = false;
    }
  }

    // PoE budgeting requires a successful AP selection.
  // If AP selection failed, preserve the incomplete plan and continue orchestration.
  let poeBudget = null;

  if (
    typeof steps.computePoeBudget === 'function' &&
    apResult?.ok === true
  ) {
    poeBudget = steps.computePoeBudget({
      requirements: planRequirements,
      apSelection: apResult,
      plan: planType,
      ctx,
    });

    plan.poeBudget = poeBudget;
  }

  // Switch selection requires both a successful AP selection and a PoE budget.
  // The switch selector has a different result contract from gateway/AP selectors.
  if (
    typeof steps.selectSwitches === 'function' &&
    apResult?.ok === true &&
    poeBudget !== null
  ) {
    const switchResult = steps.selectSwitches({
      catalog,
      vendor: vendor.name,
      requirements: planRequirements,
      poeBudget,
      apSelection: apResult,
      plan: planType,
      cePick: cePicks.switches,
      ctx,
    });

    if (!switchResult || typeof switchResult.ok !== 'boolean') {
      throw new TypeError(
        'Switch selector must return an object with an ok boolean flag.',
      );
    }

    if (switchResult.ok) {
      if (!Array.isArray(switchResult.accessSwitches)) {
        throw new TypeError(
          'Successful switch selection must include an accessSwitches array.',
        );
      }

      // NWP-ENGINE-016: the core switch is listed first among the switch items; the topology treats the first
      // switch item as the core and every later one as an access switch.
      // Preferred source: switchResult.coreSwitch ({ sku, qty }) from the core-switch selector in switches.js.
      // Stopgap until that selector exists: reuse the first access switch SKU, and only when the building has more
      // than one floor (a single-floor site has no uplinks to a core, so its access switch also serves as the core).
      let coreSwitch = null;

      if (switchResult.coreSwitch) {
        coreSwitch = switchResult.coreSwitch;
      } else if (
        switchResult.uplinksPerFloor > 0 &&
        switchResult.accessSwitches.length > 0 &&
        Number.isFinite(switchResult.coreSwitchQuantity) &&
        switchResult.coreSwitchQuantity > 0
      ) {
        coreSwitch = {
          sku: switchResult.accessSwitches[0].sku,
          qty: switchResult.coreSwitchQuantity,
        };
        addLedger(
          ctx,
          'coreSwitch',
          coreSwitch.sku.sku,
          'ESTIMATE: no core switch selector exists yet, so the first access switch model is used as the core switch.',
        );
      }

      if (coreSwitch) {
        assertSelectedVendor({ ok: true, sku: coreSwitch.sku }, vendor, 'switch');
        if (!coreSwitch.sku?.sku || !Number.isFinite(coreSwitch.qty)) {
          throw new TypeError('The core switch must include a SKU and quantity.');
        }

        plan.items.push({
          category: 'switch',
          sku: coreSwitch.sku.sku,
          qty: coreSwitch.qty,
        });
        selectedDeviceItems.push({
          sku: coreSwitch.sku,
          qty: coreSwitch.qty,
        });
      }

      switchResult.accessSwitches.forEach((accessSwitch) => {
        assertSelectedVendor(
  { ok: true, sku: accessSwitch.sku },
  vendor,
  'switch',
);
        if (!accessSwitch?.sku || !Number.isFinite(accessSwitch.qty)) {
          throw new TypeError(
            'Each selected access switch must include a SKU and quantity.',
          );
        }

        plan.items.push({
          category: 'switch',
          sku: accessSwitch.sku.sku,
          qty: accessSwitch.qty,
          floor: accessSwitch.floor,
          uplinksPerSwitch: accessSwitch.uplinksPerSwitch,
        });
        selectedDeviceItems.push({
  sku: accessSwitch.sku,
  qty: accessSwitch.qty,
});
      });

      plan.switchSelection = switchResult;
    } else {
      if (
        !switchResult.unmet ||
        typeof switchResult.unmet.category !== 'string' ||
        typeof switchResult.unmet.reason !== 'string'
      ) {
        throw new TypeError(
          'Unsuccessful switch selection must include an unmet result.',
        );
      }

      recordUnmetIfMissing(ctx, switchResult.unmet, vendor.name, catalog);
      plan.complete = false;
    }
  }

    // NWP-ENGINE-015 AC7: controller step. Selection logic lives in NWP-ENGINE-018.
    // NWP-ENGINE-018: the managed-device counts come from plan.items (gateway, APs and switches are already in it),
    // and are needed by both the integrated-controller capacity check and the standalone selection.
  if (vendor.needController && gatewayResult.ok) {
    const controller = steps.controller || controllerStep;
    const counts = controller.countManagedDevices(plan.items);

    if (!controller.integratedControllerCheck(gatewayResult.sku, ctx, counts)) {
      const controllerResult = controller.selectController(
        vendor.name, planType, counts, catalog, ctx,
      );

      validateSelectionResult(controllerResult);
      assertSelectedVendor(controllerResult, vendor, 'controller');

      if (controllerResult.ok) {
        plan.items.push({
          category: 'controller',
          sku: controllerResult.sku.sku,
          qty: controllerResult.qty,
        });
        selectedDeviceItems.push({
          sku: controllerResult.sku,
          qty: controllerResult.qty,
        });
      } else {
        recordUnmetIfMissing(ctx, controllerResult.unmet, vendor.name, catalog);
        plan.complete = false;
      }
    }
  }

  // Selector results already contain the full SKU objects needed for rack sizing.
const resolvedItems = selectedDeviceItems;
  // NWP-ENGINE-012: optics requirement uses the first selected switch.
  // Optics are a requirement only; they are not selected SKUs or BOM lines.
  const selectedSwitchSpecs =
    plan.switchSelection?.ok === true
      ? (
          plan.switchSelection.accessSwitches?.[0]?.sku?.switch_specs ??
          plan.switchSelection.accessSwitches?.[0]?.sku
         )
      : undefined;

  plan.optics = planOptics(
    input,
    planRequirements,
    selectedSwitchSpecs,
    ctx,
    plan.switchSelection?.ok === true ? plan.switchSelection : undefined,
  );
  const { requiredU } = computeRequiredRackUnits(resolvedItems, ctx);

  const enclosureResult = chooseEnclosure({
    requirements: planRequirements,
    devices: resolvedItems,
    ctx,
    catalog,
    vendor: vendor.name,
    plan: planType,
    housing: input.housing,
    requiredU,
  });

    // Preserve the enclosure selector result for both success and failure.
  plan.enclosureSelection = enclosureResult;
  assertSelectedVendor(enclosureResult, vendor, 'enclosure');

  if (enclosureResult.ok) {
    if (enclosureResult.qty > 0) {
      plan.items.push({
        category: 'enclosure',
        sku: enclosureResult.sku.sku,
        qty: enclosureResult.qty,
      });
    }
  } else {
    recordUnmetIfMissing(ctx, enclosureResult.unmet, vendor.name, catalog);
    plan.complete = false;
  }

  // NWP-ENGINE-019 AC4: one confirm-availability notice for each selected Sunsetting SKU.
  flagSunsettingSelections(
    ctx,
    enclosureResult.ok && enclosureResult.qty > 0
      ? [...selectedDeviceItems, { sku: enclosureResult.sku }]
      : selectedDeviceItems,
  );

  // Power protection is advisory; it does not select equipment or affect the BOM.
  plan.powerProtection = buildPowerProtection(
    reqs,
    input,
    plan.items,
    ctx,
    catalog,
  );

  // BOM-01
  if (typeof steps.buildBom === 'function') {
    const bom = steps.buildBom(plan, catalog);
    validateBom(bom);
    plan.bom = bom;

    const addBomAdvisory = (code, message) => {
      if (!ctx.flags.some((flag) => flag.code === code)) {
        addFlag(ctx, code, message);
      }
    };

    const unpricedLines = bom.lines.filter(
      (line) => line.unitPrice === null,
    );

    if (unpricedLines.length > 0) {
      const skus = unpricedLines.map((line) => line.sku).sort();
      addBomAdvisory(
        BOM_FLAG_CODES.PARTIAL_PRICE,
        `No catalog price is available for selected SKU(s): ${skus.join(', ')}.`,
      );
    }

    if (plan.complete === false || plan.unmet.length > 0) {
      const missing = plan.unmet
        .map((item) => `${item.category}: ${item.reason}`)
        .join('; ');

      addBomAdvisory(
        BOM_FLAG_CODES.PLAN_INCOMPLETE,
        missing
          ? `Required equipment is missing from this plan: ${missing}`
          : 'Required equipment is missing from this plan.',
      );
    }

    const staleLines = bom.lines.filter((line) => line.isStale === true);

    if (staleLines.length > 0) {
      const details = staleLines
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .map((line) => (
          line.priceUpdatedAt
            ? `${line.sku} (last verified: ${line.priceUpdatedAt})`
            : `${line.sku} (last verified date unavailable)`
        ));

      addBomAdvisory(
        BOM_FLAG_CODES.PRICE_STALE,
        `Catalog prices are stale for selected SKU(s): ${details.join(', ')}.`,
      );
    }
  }

  // NWP-BOM-002: advisory installation-materials summary (reference information, not BOM lines, not in the BOM total).
  if (typeof steps.buildInstallationMaterials === 'function') {
    plan.installationMaterials = steps.buildInstallationMaterials(plan, planRequirements);
  }

  return plan;
}

// Replace for step functions.
function toPublicPlan(plan) {
  const next = { ...plan };
  if (plan.switchSelection !== undefined) next.switchSelection = toPublicSelection(plan.switchSelection);
  if (plan.enclosureSelection !== undefined) next.enclosureSelection = toPublicSelection(plan.enclosureSelection);
  return next;
}

// Per-vendor stage: CE then HP, reduced to public form and assembled.
function buildVendorPlansAssembled({ vendor, input, requirements, catalog, sharedLedger, steps = DEFAULT_STEPS }) {
  let cePicks;
  // PLAN_TYPES lists CE first: HP steps up from what CE picked.
  return PLAN_TYPES.map(({ planType }) => {
    const planSteps = planType === 'HP' ? { ...steps, cePicks } : steps;
    const plan = buildPlan(vendor, planType, requirements, input, catalog, createCtx(), planSteps);
    if (planType === 'CE') cePicks = collectCePicks(plan, vendor.name, catalog);
    return assemblePlan(toPublicPlan(plan), { reqs: requirements, input, catalog, sharedLedger });
  });
}

// Final stage: default vendors and the merge. Needs every vendor's plans, but no catalog.
function finishEngineResult({ input, requirements, vendors, plans, sharedCtx }) {
  const selectionCtx = createCtx();
  const defaultVendor = selectDefaultVendors(plans, input, vendors, selectionCtx);
  const combined = combineAssembledPlans({
    requirements,
    sharedCtx: { ledger: sharedCtx.ledger, flags: sharedCtx.flags, unmet: [] },
    plans,
    defaultVendor,
  });
  return {
    ...combined,
    ledger: appendUnique(combined.ledger, selectionCtx.ledger),
    flags: appendUnique(combined.flags, selectionCtx.flags),
    unmet: [...sharedCtx.unmet, ...plans.flatMap((plan) => plan.unmet || [])],
  };
}

function runEngine(input, reqs, catalog, vendors, steps = DEFAULT_STEPS, sharedCtx = createCtx()) {
  validateEngineInputs(input, reqs, catalog, vendors);
  if (!sharedCtx || !Array.isArray(sharedCtx.ledger)
      || !Array.isArray(sharedCtx.flags) || !Array.isArray(sharedCtx.unmet)) {
    throw new TypeError('runEngine requires a sharedCtx from createCtx()');
  }
  const plans = vendors.flatMap((vendor) =>
    buildVendorPlansAssembled({ vendor, input, requirements: reqs, catalog, sharedLedger: sharedCtx.ledger, steps }));
  return finishEngineResult({ input, requirements: reqs, vendors, plans, sharedCtx });
}

module.exports = {
  runEngine,
  validateEngineInputs,
  PLAN_TYPES,
  createEmptyPlan,
  buildPlan,
  getPlanRequirements,
  buildVendorPlansAssembled,
  finishEngineResult
};