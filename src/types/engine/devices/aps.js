
'use strict';

const { selectSku: defaultSelectSku } = require('../select.js');
const { wirelessRequirements } = require('../requirements/wireless.js');
const { addFlag, addLedger, createCtx } = require('../ctx.js');

function getApSpecs(sku) {
  return sku.ap_specs || sku.apSpecs || sku;
}

function getWifiStandard(sku) {
  const specs = getApSpecs(sku);
  return Number(specs.wifi_standard ?? specs.wifi_gen ?? specs.wifiStandard);
}

function supports6Ghz(sku) {
  const specs = getApSpecs(sku);
  return (specs.supported_6ghz ?? specs.supported6Ghz) === true;
}

function getPoeStandard(sku) {
  const specs = getApSpecs(sku);
  const explicitStandard = specs.poe_standard ?? specs.poeStandard;

  if (['af', 'at', 'bt3'].includes(explicitStandard)) {
    return explicitStandard;
  }

  const powerMethod = String(specs.power_method ?? specs.powerMethod ?? '');
  if (/802\.3bt|poe\+\+/i.test(powerMethod)) return 'bt3';
  if (/802\.3at|poe\+/i.test(powerMethod)) return 'at';
  if (/802\.3af/i.test(powerMethod)) return 'af';

  return undefined;
}

function getMaxPowerDrawW(sku) {
  const specs = getApSpecs(sku);
  return specs.max_power_draw_w ?? specs.max_draw_w ?? specs.maxPowerDrawW ?? null;
}

function matchesGeneration(sku, target) {
  const standard = getWifiStandard(sku);

  if (!Number.isFinite(standard)) {
    return false;
  }

  if (target === '6E') {
    // Previous version:
    // return standard === 6 && supports6Ghz(sku);
    return standard >= 6 && supports6Ghz(sku);
  }

  if (target === '6') {
    return standard === 6 && !supports6Ghz(sku);
  }

  return false;
}

function normalizeApSku(sku, vendor) {
  const normalized = {
    ...sku,
    vendor: sku.vendor ?? vendor,
    category: 'access_point',
    status: String(
      sku.status ?? sku.lifecycle_status ?? ''
    ).toUpperCase(),
  };

  const maxPowerDrawW = getMaxPowerDrawW(normalized);
  if (maxPowerDrawW !== null && maxPowerDrawW !== undefined) {
    normalized.max_power_draw_w = maxPowerDrawW;
  }

  const poeStandard = getPoeStandard(normalized);
  if (poeStandard) normalized.poe_standard = poeStandard;

  return normalized;
}

function selectAccessPoints({
  catalog,
  vendor,
  vendorId,
  requirements,
  plan,
  cePick,
  ctx,
  input,
  selectSku = defaultSelectSku,
  wirelessRequirementsFn = wirelessRequirements,
}) {
  if (!Array.isArray(catalog)) {
    throw new TypeError('catalog must be an array.');
  }

  if (!requirements || !requirements.wireless) {
    throw new TypeError('requirements.wireless is required.');
  }

  if (plan !== 'CE' && plan !== 'HP') {
    throw new TypeError('plan must be CE or HP.');
  }

  if (!ctx) {
    throw new TypeError('ctx is required.');
  }

  const target = requirements.wireless.standard;

  // ENGINE-007 accepts normalized plan names.
  const selectionPlan =
    plan === 'CE' ? 'cost_efficient' : 'high_performance';

  // ENGINE-007 expects a SKU, not a SelectionResult wrapper. A catalog row also has a `sku` field (its id),
  // so only unwrap when that field is itself an object; the row is needed for its line_rank.
  const ceSku = typeof cePick?.sku === 'object' ? cePick.sku : cePick;

  const choose = (wireless, selectionCtx) => {
    const planRequirements = wireless[plan];

    if (!planRequirements || !Number.isFinite(planRequirements.total)) {
      throw new TypeError(
        `requirements.wireless.${plan}.total must be a number.`
      );
    }

    const pool = catalog
      .filter((sku) => {
        const isAp =
          sku.category === 'ap' ||
          sku.category === 'access_point';

        const matchesVendor =
          vendorId !== undefined
            ? Number(sku.vendor_id ?? sku.vendorId) === Number(vendorId)
            : sku.vendor === vendor;

        return isAp && matchesVendor;
      })
      .map((sku) => normalizeApSku(sku, vendor));

    return selectSku({
      pool,
      predicate: (sku) =>
        matchesGeneration(sku, wireless.standard),
      plan: selectionPlan,
      category: 'access_point',
      vendor,
      ctx: selectionCtx,
      qty: planRequirements.total,
      cePick: ceSku,
    });
  };

  let wireless = requirements.wireless;

  // NWP-ENGINE-019 AC3: a 6E attempt that is about to be retried must not leave an unmet requirement
  // behind, so it runs on its own context. Only the attempt that decides the outcome is kept.
  const attempt = createCtx();
  let result = choose(wireless, target === '6E' ? attempt : ctx);
  let usedFallback = false;

  // If no qualifying 6E AP is available, recalculate using Wi-Fi 6.
  if (!result.ok && target === '6E') {
    if (!input) {
      throw new TypeError(
        'input is required to recalculate wireless requirements for Wi-Fi 6 fallback.'
      );
    }

    // The sizing step records ledger entries about the shared requirement. Those are not repeated per
    // plan (one fallback entry is added below), but its advisories are kept.
    const sizing = createCtx();
    const recalculated = wirelessRequirementsFn(input, sizing, '6');
    sizing.flags.forEach((flag) => {
      if (!ctx.flags?.some((known) => known.code === flag.code)) addFlag(ctx, flag.code, flag.message);
    });

    wireless = recalculated.wireless || recalculated;

    if (!wireless || !wireless[plan]) {
      throw new TypeError(
        'Wireless requirements recalculation returned an invalid result.'
      );
    }

    result = choose(wireless, ctx);
    usedFallback = result.ok;
  } else if (target === '6E') {
    // No fallback: everything the 6E attempt recorded belongs to this plan.
    for (const key of ['ledger', 'flags', 'unmet']) {
      if (attempt[key].length > 0) (ctx[key] ??= []).push(...attempt[key]);
    }
  }

  if (!result.ok) {
    return result;
  }

  const flags = [...(result.flags || [])];

  if (usedFallback) {
    const flag = {
      code: 'WIFI_6E_FALLBACK',
      message: `6E unavailable in ${vendor} at this tier`,
    };

    flags.push(flag);
    addFlag(ctx, flag.code, flag.message);

    if (Array.isArray(ctx.ledger)) {
      addLedger(
        ctx,
        'wireless.planStandard',
        wireless.standard,
        `${vendor} has no qualifying Wi-Fi 6E access point, so the ${vendor} (${plan}) plan is sized for Wi-Fi ${wireless.standard}: ` +
          `${wireless[plan].total} access points (per floor: ${(wireless[plan].perFloor ?? []).join(', ')}). The 6E counts do not apply to this plan.`
      );
    }
  }

  return {
    ...result,
    qty: wireless[plan].total,
    // The wireless sizing this selection is based on. Later steps must use it instead of requirements.wireless.
    wireless,
    flags,
    maxPowerDrawW: getMaxPowerDrawW(result.sku),
  };
}

module.exports = {
  selectAccessPoints,
  normalizeApSku,
  matchesGeneration,
  getPoeStandard,
};
