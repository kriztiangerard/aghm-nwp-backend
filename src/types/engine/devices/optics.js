'use strict';
// NWP-ENGINE-012 — Fiber uplink optics requirement.
//
// This step produces a REQUIREMENT (links, modules, form factor), not a selection.
// Per the manuscript's delimitations, SFP modules are not BOM line items: they belong on the
// Installation Materials Summary, and the ERD does not catalogue them. So nothing here picks a SKU,
// reads the catalog, or touches a price.
//
// Consumes: NormalizedInput (floors), Requirements (backbone from 005, redundancy from 003),
//           the selected switches' specs (sfp_ports, sfp_form_factor), ctx.
// Produces: null (copper backbone) | { links, modules, formFactor, moduleTypes? }
// Rules: pure function (no I/O); assumptions go through ctx.

const { addLedger, addFlag, ValidationError } = require('../ctx.js');

// Structural, not tunable: a fiber link has two ends and each end takes one transceiver.
// Deliberately not in params.js (that file is for tunable values).
const MODULES_PER_LINK = 2;

const REDUNDANCY_VALUES = new Set(['none', 'backupWan', 'required']); // values emitted by 003
const BACKBONE_VALUES = new Set(['fiber', 'copper']);                 // values emitted by 005
const SFP_FORM_FACTORS = new Set(['SFP', 'SFP+', 'SFP28', 'QSFP+', 'QSFP28']); // ERD sfpFormFactor enum

// ---------------------------------------------------------------------------
// SUBTASK 1 — Count fiber links when there are no switch uplinks to count (single floor with existing
// fiber, or no switches selected): floors × (redundancy === 'required' ? 2 : 1).
// One uplink per floor; a second path per floor when redundancy is 'required'.
// 'backupWan' is WAN-side only and must not add backbone links.
// Invalid floors or redundancy throw ValidationError (no silent default).
// ---------------------------------------------------------------------------
function countFiberLinks(floors, redundancy) {
  if (!Number.isInteger(floors) || floors < 1) {
    throw new ValidationError('floors', 'Must be a positive integer.');
  }
  if (!REDUNDANCY_VALUES.has(redundancy)) {
    throw new ValidationError('redundancy', 'Must be one of none, backupWan, required.');
  }
  return floors * (redundancy === 'required' ? 2 : 1);
}

// ---------------------------------------------------------------------------
// SUBTASK 2 — Compute modules as 2 per link (local constant MODULES_PER_LINK above).
// Accepts 0 so a caller can reuse it harmlessly.
// ---------------------------------------------------------------------------
function countOpticModules(links) {
  if (!Number.isInteger(links) || links < 0) {
    throw new ValidationError('links', 'Must be a non-negative integer.');
  }
  return links * MODULES_PER_LINK;
}

// ---------------------------------------------------------------------------
// SUBTASK 3 — Read the form factor from the selected switch; flag when ports or
// form factor are missing. Never guesses: returns null and raises a flag instead.
// `sw` is the selected switch's specs (ERD switch_specs: sfp_ports, sfp_form_factor).
// ---------------------------------------------------------------------------
function resolveFormFactor(sw, ctx) {
  const ports = sw ? sw.sfp_ports : undefined;
  if (!Number.isFinite(ports) || ports < 1) {
    addFlag(
      ctx,
      'OPTICS_NO_SFP_PORTS',
      'The selected switch reports no SFP ports, so the transceiver form factor could not be determined.'
    );
    return null;
  }
  if (!SFP_FORM_FACTORS.has(sw.sfp_form_factor)) {
    addFlag(
      ctx,
      'OPTICS_FORM_FACTOR_UNKNOWN',
      'The selected switch has SFP ports but no recognised sfp_form_factor; confirm the module type before purchase.'
    );
    return null;
  }
  return sw.sfp_form_factor;
}

// NWP-ENGINE-019 AC7: with a core, every access switch unit has its own uplink(s), so the links are
// counted per switch. This matches the core port sizing and the topology's fiber edges per core path.
// Returns null when there are no switch uplinks to count (single floor, or no switches selected).
function countUplinkLinks(switching) {
  const links = (switching?.accessSwitches ?? []).reduce(
    (total, accessSwitch) => total + accessSwitch.qty * (accessSwitch.uplinksPerSwitch ?? 0),
    0
  );
  return links > 0 ? links : null;
}

// ---------------------------------------------------------------------------
// NWP-ENGINE-019 AC7: the module type depends on BOTH ends of a link (access switch and core).
// ---------------------------------------------------------------------------
const switchSpecsOf = (sku) => sku?.switch_specs ?? sku;

function readFormFactor(sku) {
  const specs = switchSpecsOf(sku);
  if (!Number.isFinite(specs?.sfp_ports) || specs.sfp_ports < 1) return null;
  return SFP_FORM_FACTORS.has(specs.sfp_form_factor) ? specs.sfp_form_factor : null;
}

// Same type at both ends uses that type. SFP with SFP+ runs at 1 Gbps on SFP modules. Anything else,
// or an end that is not recorded, is not guessed.
function moduleForEnds(first, second) {
  if (first === null || second === null) return { formFactor: null, mixed: false };
  if (first === second) return { formFactor: first, mixed: false };
  const ends = new Set([first, second]);
  if (ends.has('SFP') && ends.has('SFP+')) return { formFactor: 'SFP', mixed: true };
  return { formFactor: null, mixed: false };
}

// One entry per access switch group. Returns null when there are no uplinks between two switches to check.
function resolveUplinkModules(switching, ctx) {
  const groups = (switching?.accessSwitches ?? [])
    .map((accessSwitch) => ({ accessSwitch, links: accessSwitch.qty * (accessSwitch.uplinksPerSwitch ?? 0) }))
    .filter((group) => group.links > 0);
  if (groups.length === 0) return null;

  // Without a separate core selection, the core is the first access switch model (as in orchestration).
  const core = switching.coreSwitch?.sku ?? switching.accessSwitches[0].sku;

  const byType = new Map();
  const mixedPairs = new Set();
  const unreadable = new Set();

  for (const { accessSwitch, links } of groups) {
    const accessType = readFormFactor(accessSwitch.sku);
    const coreType = readFormFactor(core);
    const { formFactor, mixed } = moduleForEnds(accessType, coreType);
    const entry = byType.get(formFactor) ?? { formFactor, links: 0, modules: 0, runsAt1Gbps: false };
    entry.links += links;
    entry.modules += countOpticModules(links);
    if (mixed) {
      entry.runsAt1Gbps = true;
      mixedPairs.add(`${accessSwitch.sku?.sku ?? 'access switch'} (${accessType}) to ${core?.sku ?? 'core switch'} (${coreType})`);
    }
    byType.set(formFactor, entry);

    if (accessType === null) unreadable.add(accessSwitch.sku);
    if (coreType === null) unreadable.add(core);
    if (accessType !== null && coreType !== null && formFactor === null) {
      addFlag(
        ctx,
        'OPTICS_FORM_FACTOR_MISMATCH',
        `The two ends of a fiber uplink use ${accessType} and ${coreType} ports; confirm a compatible module before purchase.`
      );
    }
  }

  // The existing flags name why an end could not be read; each is raised once.
  const raised = new Set();
  for (const sku of unreadable) {
    const scratch = { flags: [] };
    resolveFormFactor(switchSpecsOf(sku), scratch);
    for (const flag of scratch.flags) {
      if (raised.has(flag.code)) continue;
      raised.add(flag.code);
      addFlag(ctx, flag.code, sku?.sku ? `${sku.sku}: ${flag.message}` : flag.message);
    }
  }

  if (mixedPairs.size > 0) {
    addFlag(
      ctx,
      'OPTICS_MIXED_SPEED',
      `These fiber uplinks join SFP and SFP+ ports, so they run at 1 Gbps on 1 Gbps SFP modules: ${[...mixedPairs].sort().join('; ')}. Confirm that the SFP+ port accepts a 1 Gbps SFP module.`
    );
  }

  return [...byType.values()];
}

function planOptics(input, reqs, sw, ctx, switching) {
  // -------------------------------------------------------------------------
  // SUBTASK 4 — Return null for a copper backbone; throw on an unrecognised value
  // so an upstream typo cannot silently drop the optics.
  // -------------------------------------------------------------------------
  if (!BACKBONE_VALUES.has(reqs && reqs.backbone)) {
    throw new ValidationError('backbone', 'Must be fiber or copper.');
  }
  if (reqs.backbone === 'copper') {
    return null;
  }

  const floorLinks = countFiberLinks(input.floors, reqs.redundancy); // SUBTASK 1
  const links = countUplinkLinks(switching) ?? floorLinks;
  const modules = countOpticModules(links);                       // SUBTASK 2
  const moduleTypes = resolveUplinkModules(switching, ctx);
  // SUBTASK 3: with no switch-to-switch uplinks to check, the selected switch's own ports decide.
  const formFactor = moduleTypes === null
    ? resolveFormFactor(sw, ctx)
    : moduleTypes.length === 1 ? moduleTypes[0].formFactor : null;

  // -------------------------------------------------------------------------
  // SUBTASK 5 — Record assumptions. A single floor with fiber means the user
  // reported existing fiber (005); we assume one uplink to the core (two when
  // redundancy is required). The compatibility advisory is raised for every
  // fiber backbone, since modules are listed on the Installation Materials
  // Summary rather than priced in the BOM.
  // -------------------------------------------------------------------------
  if (input.floors === 1) {
    addLedger(
      ctx,
      'fiberLinks',
      links,
      'Single floor with fiber reported; assumed one fiber uplink to the core (two if redundancy is required).'
    );
  }
  addFlag(
    ctx,
    'OPTICS_COMPATIBILITY_ADVISORY',
    'Fiber backbone: SFP modules appear on the Installation Materials Summary only. Confirm module compatibility with the chosen vendor before purchase; final quantities depend on a site survey.'
  );

  // Output deliberately has no sku, price or BOM line (AC 7).
  // The breakdown is added only when one form factor cannot describe the result.
  const needsBreakdown = moduleTypes !== null &&
    (moduleTypes.length > 1 || moduleTypes.some((entry) => entry.runsAt1Gbps));
  return needsBreakdown ? { links, modules, formFactor, moduleTypes } : { links, modules, formFactor };
}

module.exports = { planOptics, countUplinkLinks, countFiberLinks, countOpticModules, resolveFormFactor };