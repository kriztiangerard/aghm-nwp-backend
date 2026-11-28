'use strict';
// Gateway selection
// Algorithm Step 3.2
// Consumes: Requirements + select()
// Produces: SelectionResult (gateway)
// Rules: pure function (no I/O), constants from params.js, assumptions via ctx.

const { selectSku } = require('../select.js');
const { addFlag, addLedger, createCtx } = require('../ctx.js');

// One selection pass. vpnTunnelsNeeded is 0 when VPN is not being required.
function selectGatewayPass({ catalog, vendor, requirements, plan, cePick, ctx, vpnTunnelsNeeded }) {

  const pool = catalog.filter(
    (sku) => sku.vendor === vendor && sku.category === 'gateway'
  );

  const requiredMbps = requirements.requiredMbps;
  const throughputMetric = requirements.throughputMetric;

  const throughputField = {
    routing_throughput: 'routing_throughput_mbps',
    idps_throughput: 'idps_throughput_mbps',
  }[throughputMetric];

  if (requiredMbps !== undefined && !throughputField) {
    throw new Error(
      `selectGateway: unsupported throughput metric '${throughputMetric}'`
    );
  }

  const hasThroughputRequirement = Number.isFinite(requiredMbps);

  const hasKnownSufficientThroughput =
    !hasThroughputRequirement ||
    pool.some(
      (sku) =>
        ['ACTIVE', 'SUNSETTING'].includes(sku.status) &&
        typeof sku.price === 'number' &&
        Number.isFinite(sku.price) &&
        Number.isFinite(sku[throughputField]) &&
        sku[throughputField] >= requiredMbps
    );

  const hasUnknownThroughput =
    hasThroughputRequirement &&
    !hasKnownSufficientThroughput &&
    pool.some(
      (sku) =>
        ['ACTIVE', 'SUNSETTING'].includes(sku.status) &&
        typeof sku.price === 'number' &&
        Number.isFinite(sku.price) &&
        (sku[throughputField] === undefined ||
          sku[throughputField] === null)
    );

  if (hasUnknownThroughput) {
    addFlag(
      ctx,
      'GATEWAY_THROUGHPUT_UNKNOWN',
      `Some ${vendor} gateways have unknown ${throughputField}; unknown throughput is not assumed to satisfy the requirement`
    );
  }

  const predicate = (sku) => {
    // NWP-ENGINE-019 AC13: VPN support is required. The tunnel limit is checked only when it is known.
    if (
      vpnTunnelsNeeded > 0 &&
      (
        sku.site_to_site_vpn !== true ||
        (Number.isFinite(sku.max_vpn_tunnels) && sku.max_vpn_tunnels < vpnTunnelsNeeded)
      )
    ) {
      return false;
    }

    if (
      hasThroughputRequirement &&
      !(
        Number.isFinite(sku[throughputField]) &&
        sku[throughputField] >= requiredMbps
      )
    ) {
      return false;
    }

    return true;
  };

  const selectionArgs = {
    predicate,
    plan,
    category: 'gateway',
    vendor,
    ctx,
    cePick
  };

  const redundancy = requirements.redundancy;
  const needsDualWan = ['backupWan', 'required'].includes(redundancy);
  const needsHa = redundancy === 'required';

  const hasQualifyingDualWan = (tierPool) =>
    tierPool.some(
      (sku) =>
        ['ACTIVE', 'SUNSETTING'].includes(sku.status) &&
        sku.dual_wan === true &&
        (!needsHa || sku.ha_capability === true) &&
        predicate(sku) &&
        typeof sku.price === 'number' &&
        Number.isFinite(sku.price)
    );

  const hasUnknownDualWan =
    needsDualWan &&
    !hasQualifyingDualWan(pool) &&
    pool.some(
      (sku) =>
        ['ACTIVE', 'SUNSETTING'].includes(sku.status) &&
        (sku.dual_wan === undefined || sku.dual_wan === null) &&
        predicate(sku) &&
        typeof sku.price === 'number' &&
        Number.isFinite(sku.price)
    );

  if (hasUnknownDualWan) {
    addFlag(
      ctx,
      'GATEWAY_DUAL_WAN_UNKNOWN',
      `Some ${vendor} gateways have unknown dual_wan capability; unknown capability is not assumed to satisfy the redundancy requirement`
    );
  }

  const selectForTier = (tierPool) => {
    if (!needsDualWan) {
      return selectSku({ ...selectionArgs, pool: tierPool, qty: 1 });
    }

    const dualWanPool = tierPool.filter(
      (sku) => sku.dual_wan === true
    );

    if (!needsHa) {
      return selectSku({
        ...selectionArgs,
        pool: dualWanPool,
        qty: 1
      });
    }

    const haPool = dualWanPool.filter(
      (sku) => sku.ha_capability === true
    );

    if (hasQualifyingDualWan(tierPool)) {
      return selectSku({
        ...selectionArgs,
        pool: haPool,
        qty: 2
      });
    }

    const result = selectSku({
      ...selectionArgs,
      pool: dualWanPool,
      qty: 1
    });

    if (!result.ok) {
      return result;
    }

    const code = 'GATEWAY_HA_UNSUPPORTED';
    const message = `HA gateway pairing not supported by ${vendor} at this tier`;

    addFlag(ctx, code, message);

    return {
      ...result,
      flags: [...result.flags, { code, message }]
    };
  };

  if (requirements.securityTier !== 'advanced') {
    return selectForTier(pool);
  }

  const advancedPool = pool.filter(
    (sku) =>
      typeof sku.idps_throughput_mbps === 'number' &&
      Number.isFinite(sku.idps_throughput_mbps) &&
      sku.idps_throughput_mbps > 0
  );

  const hasQualifyingAdvancedGateway = advancedPool.some(
    (sku) =>
      ['ACTIVE', 'SUNSETTING'].includes(sku.status) &&
      predicate(sku) &&
      (!needsDualWan ||
        (sku.dual_wan === true &&
          (!needsHa || sku.ha_capability === true))) &&
      typeof sku.price === 'number' &&
      Number.isFinite(sku.price)
  );

  if (hasQualifyingAdvancedGateway) {
    return selectForTier(advancedPool);
  }

  addFlag(
    ctx,
    'GATEWAY_SECURITY_TIER_FALLBACK',
    `No qualifying advanced-security ${vendor} gateway is available; selection fell back to the base security tier`
  );
  addLedger(
    ctx,
    'securityTier',
    'base',
    'No purchasable gateway with positive IDPS throughput met the other requirements; base security tier was used.'
  );

  return selectForTier(pool);
}

// Keeps what a selection pass recorded, without repeating an entry the plan already has.
function keepRecords(ctx, pass) {
  for (const key of ['ledger', 'flags', 'unmet']) {
    if (pass[key].length > 0) (ctx[key] ??= []).push(...pass[key]);
  }
}

function selectGateway(args) {
  const { vendor, requirements, plan, ctx } = args;

  if (plan !== 'cost_efficient' && plan !== 'high_performance') {
    throw new Error(`selectGateway: unknown plan '${plan}'`);
  }

  const planKey = plan === 'cost_efficient' ? 'CE' : 'HP';
  const vpnTunnelsNeeded = requirements.vpnTunnelsNeeded?.[planKey] ?? 0;

  if (vpnTunnelsNeeded <= 0) {
    return selectGatewayPass({ ...args, vpnTunnelsNeeded: 0 });
  }

  const withVpn = createCtx();
  const result = selectGatewayPass({ ...args, ctx: withVpn, vpnTunnelsNeeded });

  if (result.ok) {
    keepRecords(ctx, withVpn);
    if (!Number.isFinite(result.sku.max_vpn_tunnels)) {
      addFlag(
        ctx,
        'GATEWAY_VPN_CAPACITY_UNKNOWN',
        `${result.sku.sku} supports site-to-site VPN, but its tunnel limit is not in the catalog; confirm it supports at least ${vpnTunnelsNeeded} tunnel(s) before purchase.`
      );
    }
    return result;
  }

  // No gateway can meet the VPN need. A gateway is still recommended, and VPN is recorded as unmet.
  const withoutVpn = createCtx();
  const fallback = selectGatewayPass({ ...args, ctx: withoutVpn, vpnTunnelsNeeded: 0 });

  if (!fallback.ok) {
    keepRecords(ctx, withVpn);
    return result;
  }

  keepRecords(ctx, withoutVpn);

  return {
    ...fallback,
    vpnUnmet: {
      category: 'gateway',
      vendor,
      reason:
        `Site-to-site VPN (${vpnTunnelsNeeded} tunnel(s)) is not met: no purchasable ${vendor} gateway with enough VPN support ` +
        `meets the other requirements. ${fallback.sku.sku} is shown without it`,
    },
  };
}

module.exports = { selectGateway };
