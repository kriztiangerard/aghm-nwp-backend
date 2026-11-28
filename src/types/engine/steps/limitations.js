'use strict';

// NWP-ENGINE-016: limitations list for one plan.
// Pure function. The wording below is a draft for team review; the rules that decide when a line appears are the logic.
//
// STATIC_LIMITATIONS always appear (manuscript scope and delimitations).
// Conditional lines are driven by the facts of the run: input, the plan itself, and its assumptions ledger.

// Planning guidance from older editions of the TIA-569 cabling pathways standard. It only raises a warning.
const CLOSET_FLOOR_AREA_WARNING_SQM = 1000;

const STATIC_LIMITATIONS = Object.freeze([
  'Planning stage only: this output supports early network planning. It is not a site survey or a professional installation design, and final hardware selection, procurement and installation remain the responsibility of qualified network professionals and the deploying organization.',
  'The Bill of Materials covers major network equipment only (gateways/routers, switches, wireless access points, controllers where applicable, and racks or enclosures). Firewall functions are provided by the gateway and appear as a logical node in the topology. No separate firewall appliance is included or priced. It excludes cabling, cable accessories and other minor installation materials, and actual quantities must be determined through a physical site survey and detailed deployment planning.',
  'The topology is a logical design only. It does not include IP addressing, rack elevations, wireless coverage analysis, cable routing or network simulation.',
  'Prices are planning estimates based on the product catalog at the time the plan was generated. Actual prices may vary due to taxes, shipping, installation fees, promotions and product availability, so confirm current pricing and availability with the distributor before purchasing.',
]);

const GREENFIELD_NOTICE =
  'Existing equipment was reported or is unknown, but this plan is a full greenfield replacement estimate. Existing functional cabling or infrastructure may be repurposed after a physical site inspection, which could reduce the final deployment cost.';

const ASSUMED_LAYOUT_NOTICE =
  'In the topology, the attachment of devices to switches is an assumed layout (a fixed fill rule), not a survey result. The real attachment depends on the site.';

const GENERIC_ENCLOSURE_NOTICE =
  'The rack or cabinet in the Bill of Materials is a generic size. Any rack or wall cabinet model with at least that capacity (in rack units) can be used.';

const PER_FLOOR_CLOSET_NOTICE =
  'The plan assumes one network closet or small wall cabinet on each floor, each sized on its own equipment, with the gateway, core switch and any hardware controller in the Floor 1 closet. A site survey may combine closets.';

const UNKNOWN_OTHER_DEVICES_NOTICE =
  'The number of other devices was not provided, so they are drawn as one group without a count.';

// NWP-ENGINE-019 AC19: planning notes only. The security tier does not depend on them.
const NO_COMPLIANCE_CHECK = 'This system does not check compliance or give legal advice.';
const POS_APPS = new Set(['live pos', 'pos payment', 'pos/payments']);

function regulationNotes(input) {
  const usesPos = Array.isArray(input.apps) &&
    input.apps.some((app) => POS_APPS.has(String(app).trim().toLowerCase()));
  const notes = [];

  if (usesPos || (input.sensitiveData === true && input.sensitiveDataUnsure !== true)) {
    notes.push(`The Data Privacy Act of 2012 (RA 10173) likely applies to your business based on your answers. ${NO_COMPLIANCE_CHECK}`);
  } else if (input.sensitiveDataUnsure === true) {
    notes.push(`The Data Privacy Act of 2012 (RA 10173) may apply to your business; check what personal or sensitive data you handle. ${NO_COMPLIANCE_CHECK}`);
  }

  if (usesPos) {
    notes.push(`PCI DSS applies if you accept or process payment cards. ${NO_COMPLIANCE_CHECK}`);
  }

  return notes;
}

const TOPOLOGY_LEDGER_FIELD = 'topology.attachment';

const sentence = (text) => {
  const trimmed = String(text).trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const formatValue = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

function buildLimitations(plan, input, ledger = []) {
  if (!plan || typeof plan !== 'object') throw new TypeError('plan must be an object.');
  if (!input || typeof input !== 'object') throw new TypeError('input must be an object.');
  if (!Array.isArray(ledger)) throw new TypeError('ledger must be an array.');

  const lines = [...STATIC_LIMITATIONS];
  const label = `${plan.vendor} (${plan.planType})`;

  if (input.existingEquipment === 'yes' || input.existingEquipment === 'notSure') {
    lines.push(GREENFIELD_NOTICE);
  }

  for (const unmet of Array.isArray(plan.unmet) ? plan.unmet : []) {
    lines.push(`Requirement not met by ${label}: ${unmet.category} — ${sentence(unmet.reason)}`);
  }

  if (plan.complete === false) {
    lines.push(
      `The ${label} plan is incomplete (complete: false): its Bill of Materials and cost cover only the devices that could be selected.`
    );
  }

  const bomLines = Array.isArray(plan.bom?.lines) ? plan.bom.lines : [];
  if (plan.bom?.totalIsPartial === true) {
    if (bomLines.some((line) => line.unitPrice === null)) {
      lines.push(
        'The total cost is partial: one or more items have no price on file (price on request), so the total excludes them.'
      );
    } else if (plan.complete !== false) {
      lines.push('The total cost is partial and does not cover every item in the plan.');
    }
  }

  // Every ledger entry is a default or an estimate used in sizing, except the topology layout, which has its own line.
  for (const entry of ledger) {
    if (entry.field === TOPOLOGY_LEDGER_FIELD) continue;
    lines.push(`Default or estimate used: ${entry.field} = ${formatValue(entry.valueUsed)}. ${sentence(entry.reason)}`);
  }

  if (plan.topology) {
    lines.push(ASSUMED_LAYOUT_NOTICE);
    const nodes = Array.isArray(plan.topology.nodes) ? plan.topology.nodes : [];
    if (nodes.some((node) => node.clientKind === 'other_devices' && node.count === null)) {
      lines.push(UNKNOWN_OTHER_DEVICES_NOTICE);
    }
  }

  if (bomLines.some((line) => line.category === 'enclosure' && line.isGeneric === true)) {
    lines.push(GENERIC_ENCLOSURE_NOTICE);
  }

  // NWP-ENGINE-019 AC10: state the closet assumption, and warn about floors too large for one closet.
  if (input.floors > 1) {
    lines.push(PER_FLOOR_CLOSET_NOTICE);
  }
  const areas = Array.isArray(input.floorArea) ? input.floorArea : [];
  const largeFloors = areas.flatMap((area, index) =>
    Number.isFinite(area) && area > CLOSET_FLOOR_AREA_WARNING_SQM ? [index + 1] : []
  );
  if (largeFloors.length > 0) {
    lines.push(
      `${largeFloors.length === 1 ? `Floor ${largeFloors[0]} is` : `Floors ${largeFloors.join(', ')} are`} larger than ${CLOSET_FLOOR_AREA_WARNING_SQM.toLocaleString('en-US')} m² and may need more than one network closet; confirm this through a site survey.`
    );
  }

  // NWP-ENGINE-019 AC18: other devices have no count, so say that sizing leaves them out.
  const otherDevices = input.otherDevices?.hasOtherDevices === true
    ? String(input.otherDevices.description ?? '').trim()
    : '';
  if (otherDevices.length > 0) {
    lines.push(
      `You listed other devices: "${otherDevices}". They are not counted in the switch ports or the PoE budget, so check their connection and power needs separately.`
    );
  }

  lines.push(...regulationNotes(input));

  return [...new Set(lines)];
}

module.exports = { buildLimitations, STATIC_LIMITATIONS };