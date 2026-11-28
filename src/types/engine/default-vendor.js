'use strict';

const params = require('./params.js');
const { addLedger, addFlag } = require('./ctx.js');

const PLAN_TYPES = ['CE', 'HP'];

function getBudgetCap(input) {
  const caps = params.BUDGET_BAND_PLAN_CAP_PHP;

  if (caps == null || input.monthlyBudgetBand == null) {
    return null;
  }

  if (typeof caps === 'number') {
    return caps;
  }

  if (
    typeof caps === 'object' &&
    Object.prototype.hasOwnProperty.call(caps, input.monthlyBudgetBand)
  ) {
    return caps[input.monthlyBudgetBand];
  }

  return null;
}

function getPlanTotal(plan) {
  const total = plan?.bom?.total;

  return typeof total === 'number' && Number.isFinite(total)
    ? total
    : null;
}

function compareCandidates(a, b, vendorOrder) {
  const aTotal = getPlanTotal(a.plan);
  const bTotal = getPlanTotal(b.plan);

  // A null total is always ranked last.
  if (aTotal === null && bTotal !== null) return 1;
  if (aTotal !== null && bTotal === null) return -1;

  // For non-null totals, non-partial plans rank ahead of partial plans.
  const aIsPartial = a.plan.bom?.totalIsPartial === true;
  const bIsPartial = b.plan.bom?.totalIsPartial === true;

  if (aIsPartial !== bIsPartial) {
    return aIsPartial ? 1 : -1;
  }

  // Within the same completeness group, the lower total wins.
  if (aTotal !== bTotal) {
    return aTotal - bTotal;
  }

  // Equal totals: earlier vendor in the supplied list wins.
  const aVendorOrder = vendorOrder.has(a.plan.vendor)
    ? vendorOrder.get(a.plan.vendor)
    : Infinity;
  const bVendorOrder = vendorOrder.has(b.plan.vendor)
    ? vendorOrder.get(b.plan.vendor)
    : Infinity;

  if (aVendorOrder !== bVendorOrder) {
    return aVendorOrder - bVendorOrder;
  }

  // Preserve original plan order if all ranking criteria are equal.
  return a.index - b.index;
}

const TIER_NAMES = Object.freeze({ 1: 'budget', 2: 'mid', 3: 'higher' });
const HIGHEST_TIER = 3;
const MID_TIER = 2;

// NWP-ENGINE-019 AC11: the budget band sets the tier; downtime may raise it by one; no IT support caps it
// at mid. Returns null (no tier preference) when the budget band is unknown.
function getPreferredTier(input) {
  const fromBudget = params.PREFERRED_TIER_BY_BUDGET_BAND[input.monthlyBudgetBand];
  if (fromBudget === undefined) return null;

  let tier = fromBudget;
  if (input.downtime === 'everyMinute') tier = Math.min(HIGHEST_TIER, tier + 1);
  if (input.itSupport === 'none') tier = Math.min(MID_TIER, tier);
  return tier;
}

const tierOf = (vendorName) => params.VENDOR_PRICE_TIERS[vendorName] ?? null;

// The preferred tier if it has a candidate, else the nearest tier (cheaper first on a tie). Vendors with no
// tier are used only when no candidate has one.
function filterByTier(candidates, preferredTier) {
  if (preferredTier === null) return { candidates, tier: null };

  const tiers = [...new Set(candidates.map(({ plan }) => tierOf(plan.vendor)).filter((tier) => tier !== null))]
    .sort((a, b) => Math.abs(a - preferredTier) - Math.abs(b - preferredTier) || a - b);
  if (tiers.length === 0) return { candidates, tier: null };

  return {
    candidates: candidates.filter(({ plan }) => tierOf(plan.vendor) === tiers[0]),
    tier: tiers[0],
  };
}

function selectDefaultVendors(plans, input, vendors, ctx) {
  const defaultVendor = { CE: null, HP: null };

  const vendorOrder = new Map(
    vendors.map((vendor, index) => [vendor.name, index])
  );

  addLedger(
    ctx,
    'defaultVendor.selectionRule',
    'Complete plans; preferred price tier, else the nearest tier (cheaper first); non-partial totals first, then lowest total; vendor order breaks ties',
    'CE and HP defaults are selected independently using plan data.'
  );

  addLedger(
    ctx,
    'defaultVendor.managementPreference',
    input.management,
    input.management === 'notSure'
      ? 'No management-mode filter is applied.'
      : 'Only vendors supporting the selected management mode are preferred.'
  );

  addLedger(
    ctx,
    'defaultVendor.budgetFilter',
    params.BUDGET_BAND_PLAN_CAP_PHP,
    params.BUDGET_BAND_PLAN_CAP_PHP === null
      ? `No plan-total cap is defined for monthly budget band ${input.monthlyBudgetBand}; no budget filtering is applied.`
      : 'The configured plan-total cap is evaluated separately for each plan type and monthly budget band.'
  );

  const preferredTier = getPreferredTier(input);

  addLedger(
    ctx,
    'defaultVendor.preferredTier',
    preferredTier === null ? 'none' : TIER_NAMES[preferredTier],
    preferredTier === null
      ? 'No monthly budget band is available, so no price tier is preferred.'
      : `Set from monthly budget (${input.monthlyBudgetBand}), downtime tolerance (${input.downtime}) and IT support (${input.itSupport}). Vendor price tiers are a team judgement and only choose the default.`
  );

  for (const planType of PLAN_TYPES) {
    const completeCandidates = plans
      .map((plan, index) => ({ plan, index }))
      .filter(
        ({ plan }) =>
          plan.planType === planType && plan.complete === true
      );

    if (completeCandidates.length === 0) {
      addFlag(
        ctx,
        `DEFAULT_VENDOR_NO_COMPLETE_${planType}_PLAN`,
        `No complete ${planType} plan is available; the default vendor is null.`
      );

      addLedger(
        ctx,
        `defaultVendor.${planType}`,
        null,
        `No complete ${planType} plan was available.`
      );

      continue;
    }

    let candidates = completeCandidates;

    if (input.management === 'dashboard' || input.management === 'cli') {
      const managementCandidates = candidates.filter(({ plan }) => {
        const descriptor = vendors.find(
          (vendor) => vendor.name === plan.vendor
        );

        return descriptor?.managementModes?.includes(input.management);
      });

      if (managementCandidates.length === 0) {
        addLedger(
          ctx,
          `defaultVendor.${planType}.managementFilter`,
          input.management,
          `The management filter was ignored because it left no ${planType} candidates.`
        );
      } else {
        candidates = managementCandidates;

        addLedger(
          ctx,
          `defaultVendor.${planType}.managementFilter`,
          input.management,
          `Only ${planType} candidates supporting ${input.management} were retained.`
        );
      }
    } else {
      addLedger(
        ctx,
        `defaultVendor.${planType}.managementFilter`,
        'notSure',
        'The management filter was not applied.'
      );
    }

    const budgetCap = getBudgetCap(input);

    if (budgetCap === null) {
      addLedger(
        ctx,
        `defaultVendor.${planType}.budgetFilter`,
        'not applied',
        `No plan-total cap is configured for monthly budget band ${input.monthlyBudgetBand}; no budget filtering was applied.`
      );
    } else {
      const budgetCandidates = candidates.filter(({ plan }) => {
        const total = getPlanTotal(plan);
        return total !== null && total <= budgetCap;
      });

      if (budgetCandidates.length > 0) {
        candidates = budgetCandidates;

        addLedger(
          ctx,
          `defaultVendor.${planType}.budgetFilter`,
          budgetCap,
          `Only ${planType} candidates with a valid BOM total at or below PHP ${budgetCap} were retained.`
        );
      } else {
        addLedger(
          ctx,
          `defaultVendor.${planType}.budgetFilter`,
          'ignored',
          `No complete ${planType} candidates fit the budget cap of PHP ${budgetCap}; the budget filter was dropped.`
        );
      }
    }

    const tiered = filterByTier(candidates, preferredTier);
    candidates = tiered.candidates;

    if (preferredTier !== null) {
      addLedger(
        ctx,
        `defaultVendor.${planType}.tier`,
        tiered.tier === null ? 'not applied' : TIER_NAMES[tiered.tier],
        tiered.tier === null
          ? `No ${planType} candidate has a price tier, so the tier preference was not applied.`
          : tiered.tier === preferredTier
            ? `The preferred ${TIER_NAMES[preferredTier]} tier has a complete ${planType} plan.`
            : `No complete ${planType} plan is in the preferred ${TIER_NAMES[preferredTier]} tier, so the nearest tier was used.`
      );
    }

    candidates.sort((a, b) => compareCandidates(a, b, vendorOrder));

    const winner = candidates[0].plan;
    defaultVendor[planType] = winner.vendor;

    addLedger(
      ctx,
      `defaultVendor.${planType}`,
      winner.vendor,
      `Selected from ${candidates.length} eligible ${planType} candidate(s).`
    );
  }

  return defaultVendor;
}

module.exports = { selectDefaultVendors };
