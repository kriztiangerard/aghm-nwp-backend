# Ruijie Reyee — Official Specification References

Story: NWP-SETUP-010
Vendor: Ruijie
Vendor ID: 4
Controller required: false
Management modes: dashboard

## Source Collection Rules

- Prefer official Ruijie Reyee product pages and datasheets.
- Record the exact SKU for each device.
- Use published specifications rather than estimated values.
- Record firewall, switch, and controller capabilities only when documented.
- Check official lifecycle notices for EOS/EOL information.
- Leave EOS/EOL dates null when no dates are published.
- Record the source and justification for product-line rankings.

## Gateway / Router References

- RG-EG105G-V3:
  https://reyee.ruijie.com/en-global/products/reyee-router/eg-series/eg105gv3/

- RG-EG105G-P-V3:
  https://reyee.ruijie.com/en-global/products/reyee-router/eg-series/eg105g-p-v3/

## Switch References

- Reyee switch product selector:
  https://reyee.ruijie.com/en-global/product-selector/?category=SME&subcategory=Switches

## Access Point References

- Reyee SME product catalog:
  https://reyee.ruijie.com/en-global/products/sme/

## Lifecycle References

- Ruijie lifecycle information:
  https://id.ruijienetworks.com/support/xw/57192

## Verification Status

Individual SKU specifications: Pending
Product-line rankings: Pending
Per-SKU lifecycle verification: Pending
Schema validation: Pending

## Initial SKU Shortlist

The following models are candidates for the Reyee catalog.
Technical specifications, lifecycle status, and availability
must be verified individually before JSON insertion.

### Gateway / Router

| SKU | Selection Purpose |
| --- | --- |
| RG-EG105G-V3 | Entry cloud-managed gateway |
| RG-EG105G-P-V3 | Entry gateway with PoE ports |
| RG-EG305GH-P-E | Higher-throughput PoE gateway |
| RG-EG710XS | High-capacity gateway |

Official catalog:
https://reyee.ruijie.com/en-global/products/reyee-router/

### Switch

| SKU | Selection Purpose |
| --- | --- |
| RG-ES216GC-V2 | Smart-managed non-PoE switch |
| RG-ES228GS-LP | Smart-managed PoE switch |
| RG-NBS5200-24GT4XS-P-V2 | Layer 3 managed PoE switch |

Official catalog:
https://reyee.ruijie.com/en-global/products/reyee-switch/

### Access Point

| SKU | Selection Purpose |
| --- | --- |
| RG-RAP2266 | Wi-Fi 6 AX3000 class |
| RG-RAP72 | Wi-Fi 7 BE3600 class |
| RG-RAP73HD | Higher-performance Wi-Fi 7 |

Official catalog:
https://reyee.ruijie.com/en-global/products/reyee-wireless/

## Data Verification Checklist

- [ ] Verify individual model datasheets
- [ ] Verify WAN/LAN and switch port classifications
- [ ] Verify PoE standards and power budgets
- [ ] Verify firewall throughput and session specifications
- [ ] Verify integrated switch/controller functionality
- [ ] Verify product-line ranking evidence
- [ ] Verify per-SKU lifecycle notices
- [ ] Verify schema compatibility

## Verified Router Product Pages

### RG-EG305GH-P-E
Official source:
https://reyee.ruijie.com/en-global/products/reyee-router/eg-series/rg-eg305gh-p-e/

Manufacturer-listed:
- Router throughput: 1500 Mbps
- Client capacity: 350
- VPN tunnels: 64
- PoE outputs: 4

### RG-EG710XS
Official source:
https://reyee.ruijie.com/en-global/products/reyee-router/eg-series/rg-eg710xs/

Manufacturer-listed:
- Router throughput: 3000 Mbps
- Client capacity: 700
- VPN tunnels: 300

### Firewall Specification Verification

Router throughput must not be substituted for firewall throughput.
Client capacity must not be substituted for concurrent firewall sessions.
VPN tunnel count must not be substituted for VPN throughput.

Firewall specification blocks require separately verified metrics.
Integrated switch and controller blocks require documented functionality.

## AC5 — Integrated Switch Classification

Models reviewed:
- RG-EG105G-P-V3
- RG-EG305GH-P-E

Official product pages identify both devices as cloud-managed
PoE gateways.

RG-EG105G-P-V3:
- Four PoE+ outputs
- PoE budget: 54 W

RG-EG305GH-P-E:
- Four PoE outputs
- PoE budget: 60 W

Decision:
Do not include switch_specs or the switch capability unless
manufacturer documentation confirms integrated switching
functionality appropriate to the database's switch subtype.

The devices retain gateway_router_specs and their documented
fixed LAN-port counts.

If switch_specs is subsequently added, gateway_router_specs.lan_ports
must be set to 0 to satisfy device-schemas.json.

Status: Provisional classification pending any additional
manufacturer evidence.

## AC4 — Firewall-Rated Gateway Verification

Models reviewed:
- RG-EG105G-V3
- RG-EG105G-P-V3
- RG-EG305GH-P-E
- RG-EG710XS

Manufacturer-verified findings:

- RG-EG105G-V3: Stateful ACL and IPsec VPN bandwidth of 28 Mbps.
  A separate stateful firewall designation was not established.
- RG-EG105G-P-V3: Stateful ACL and IPsec VPN bandwidth of 28 Mbps.
  A separate stateful firewall designation was not established.
- RG-EG305GH-P-E: Stateful firewall supported; IPsec VPN
  bandwidth of 170 Mbps.
- RG-EG710XS: Stateful firewall supported; IPsec VPN
  bandwidth of 1100 Mbps.

Catalog decisions:

- RG-EG305GH-P-E and RG-EG710XS have the `firewall` capability
  and verified `firewall_specs.vpn_throughput_mbps` values.
- RG-EG105G-V3 and RG-EG105G-P-V3 retain router/controller
  capabilities without a separate firewall classification.
- Dedicated firewall throughput remains omitted where unpublished.
- General router throughput must never be substituted for
  dedicated firewall throughput.
- Concurrent client counts must not be treated as firewall sessions.
- VPN tunnel counts must not be treated as VPN throughput.
- The gateway's integrated firewall is distinct from a
  separately purchasable firewall appliance.

Additional source investigated:
https://reyee.ruijie.com/tr-tr/products/reyee-firewalls/z-series/rgwall1600z3200s/

RG-WALL 1600-Z3200-S is a standalone firewall and must not
be treated as an integrated specification of an RG-EG router.

AC4 status: Verified for the two gateways with documented
stateful firewall functionality.

## Switch Rack-Mount Verification

Official installation references:

RG-ES216GC-V2:
https://reyee.ruijie.com/en-global/support/documents/slide_rg-es216gc-v2-es224gc-v2-installation-guide/

RG-ES228GS-LP:
https://reyee.ruijie.com/en-global/support/documents/slide_ruijie-reyee-rg-es220gs-lp-and-rg-es228gs-lp-switches-installation-guide/

RG-NBS5200-24GT4XS-P-V2:
https://reyee.ruijie.com/en-global/support/documents/slide_ruijie-reyee-rg-nbs5200-24gt4sfp-p-v2-switch-installation-guide/

Verification status:
- All three switches pass JSON Schema validation.
- Product-line references and port-count consistency pass.
- Rack mounting and exact U-height require final verification
  against manufacturer installation documentation.
- Current rack-mounting JSON values are provisional.
- Per-SKU lifecycle verification remains pending.

## AC7 — Lifecycle Verification

Official lifecycle portal:
https://www.ruijie.com/en-global/support/productLifecycle

Official lifecycle policy:
https://www.ruijie.com/en-global/support/xw/57192

Screening performed: 2026-11-21

Exact SKUs screened:
- RG-EG105G-V3
- RG-EG105G-P-V3
- RG-EG305GH-P-E
- RG-EG710XS
- RG-ES216GC-V2
- RG-ES228GS-LP
- RG-NBS5200-24GT4XS-P-V2
- RG-RAP2266
- RG-RAP72
- RG-RAP73HD

Result:
No exact SKU matches were found in the main lifecycle
page text retrieved during screening.

Important:
The main lifecycle page may not contain every announcement.
Additional category listings and product-specific notices
must be checked before final QA approval.

Version distinction:
Ruijie's March 25, 2025 EOS announcement applies to
RG-EG105G V2 and RG-EG105G-P V2, not automatically to V3.

Reference:
https://www.ruijie.com/en-global/support/xw/eg105g-v2-eg105g-p-v2-eos

Current dataset:
- lifecycle_status: active (provisional)
- eos_date: null
- eol_date: null

Do not calculate EOS/EOL dates from standard support periods.
Replace provisional statuses only with manufacturer-supported
lifecycle information.

AC7 status: Pending final per-SKU verification.

## RG-EG710XS — Detailed Datasheet Findings

Source:
references/routers/datasheets/RG-EG710XS.pdf

### System Performance — Page 5

- Maximum concurrent sessions: 150000
- Normal throughput: 3000 Mbps
- Recommended concurrent clients: 700
- Rack height: 1U

### Firewall and VPN — Pages 12–13

- Stateful firewall: supported
- IPsec VPN bandwidth: 1100 Mbps
- L2TP VPN bandwidth: 1100 Mbps
- OpenVPN bandwidth: 350 Mbps
- PPTP VPN bandwidth: 1700 Mbps
- WireGuard performance: 1100 Mbps

### Integrated Controller Capabilities — Page 13

- AC mode: supported
- Maximum APs in AC mode: 800
- Maximum managed devices: 128

The catalog includes `controller_specs` with
`controller_type: integrated` and `max_managed_aps: 800`.

The 800-AP maximum is explicitly an AC-mode figure.
Separate managed-switch and managed-gateway capacities remain omitted.
The current schema does not distinguish AC-mode and router-mode limits,
so the 800-AP value must not be interpreted as a verified router-mode
management capacity.

### AC4 Decision

The datasheet confirms stateful firewall functionality,
concurrent-session capacity, and VPN performance.

However, the published 3000 Mbps throughput is labelled as
general system throughput, not specifically firewall throughput.

Do not assign this value to firewall_throughputs_mbps without
additional manufacturer evidence.

The catalog includes `firewall_specs.vpn_throughput_mbps: 1100`
using the verified IPsec VPN bandwidth.

Dedicated firewall throughput remains omitted because the
manufacturer does not separately publish that measurement.

Status: Stateful firewall and VPN bandwidth verified;
dedicated firewall throughput not published.

## AC5 — Integrated Switching Classification

### RG-EG710XS
Source: RG-EG710XS official datasheet, page 7.

Documented Ethernet switching features:
- VLAN support: Yes
- Maximum VLANs: 128
- Port-based VLAN: Yes
- VLAN priority: Yes
- Link aggregation: No
- LLDP: No
- Super-VLAN: No

These features establish VLAN and Ethernet switching functionality,
but do not independently establish a separately modeled integrated
switch role under the catalog's capability classification.

Decision:
- Preserve router, firewall, and controller capabilities.
- Do not add switch_specs without stronger integrated-switch evidence.
- Do not change gateway_router_specs.lan_ports solely to satisfy
  the integrated-switch schema rule.

### Other Reyee Gateways

RG-EG105G-V3, RG-EG105G-P-V3, and RG-EG305GH-P-E
have not been confirmed as separately modeled integrated switches.

PoE output alone is not sufficient evidence for the switch capability.

AC5 switching classification remains subject to QA review.

## AC7 — Confirmed RG-RAP73HD End of Sale

Official manufacturer notice:
https://www.ruijie.com/en-global/support/xw/rap73hd-eos

Announcement date: 2026-06-03
Affected SKU: RG-RAP73HD
Market: International
End of Sale: 2026-06-03
Last Date of Support: 2031-06-03

Catalog classification as of 2026-11-21:
- lifecycle_status: sunsetting
- eos_date: 2026-06-03
- eol_date: 2031-06-03

The catalog's eol_date represents the manufacturer's
last date of support under the team's lifecycle rules.

## AC7 — Additional Manufacturer Lifecycle Evidence

Verification date: 2026-11-21

### RG-EG105G-V3 and RG-EG105G-P-V3

Official notice:
https://www.ruijie.com/en-global/support/xw/eg105g-v2-eg105g-p-v2-eos

The notice dated 2025-03-25 identifies these V3 models
as replacements for the older V2 models.

The V2 end-of-sale and support dates must not be assigned
to the V3 SKUs.

No exact V3 EOS/EOL date established from this notice.

### RG-ES216GC-V2

Official notice:
https://www.ruijie.com/en-global/support/xw/es216gc-es224gc-eos

The notice dated 2024-02-21 identifies RG-ES216GC-V2
as a replacement for RG-ES216GC.

The older model's lifecycle dates do not apply to V2.

### RG-NBS5200-24GT4XS-P-V2

Official manufacturer firmware listing:
https://reyee.ruijie.com/en-global/resources/software/nbs5200-24gt4xs-p-v2-firmwares/nbs5200-24gt-4sfp-p-v2-390-firmware/

Firmware release date: 2026-07-13.

This establishes evidence of recent software support,
not necessarily current sales availability.

### Remaining Lifecycle Uncertainty

Other catalog entries retain provisional active classifications
unless an exact SKU-specific lifecycle notice establishes
another status.

Unknown EOS/EOL dates remain null. No dates are inferred
from warranty periods, product replacements, or similar SKUs.

## RG-EG105G-P-V3 — Verified Controller Capabilities

Official datasheet:
https://eo-sgp-cos.ruijie.com/Document/pdf/2026/4/21/RG-EG105G-P-V3_Datasheet_Official_2026-04-21.pdf

Verified on 2026-11-21.

- AC mode: supported (page 8).
- Router-mode management: 32 AP/NBS-series devices and 128 ES-series devices (page 14).
- AC-mode management: 300 AP/NBS-series devices and 128 ES-series devices (page 14).
- Maximum APs in AC mode: 300 (page 16).
- Stateful ACL: supported (page 15).
- IPsec VPN bandwidth: 28 Mbps (page 16).
- Normal routing throughput: 600 Mbps; Turbo Mode: 1000 Mbps (page 8).
- One fixed WAN, three fixed LAN, and one configurable LAN/WAN port (page 6).

Catalog decision:
- Add the `controller` capability because the manufacturer confirms AC mode.
- Omit `controller_specs` because the current schema cannot distinguish router-mode
  and AC-mode limits or precisely model the combined AP/NBS management capacity.
- Do not infer a dedicated `firewall` capability from stateful ACL alone.
- Do not infer a separate integrated `switch` capability from PoE ports.
- Preserve the fixed WAN/LAN counts and normal-mode throughput.

## RG-EG105G-V3 — Verified Controller Capabilities

Official manufacturer datasheet:
https://eo-sgp-cos.ruijie.com/Document/pdf/2026/9/1/RG-EG105G-V3_Datasheet_Official_2026-09-01.pdf

Verified on 2026-11-21.

- Normal routing throughput: 600 Mbps; Turbo Mode: 1000 Mbps (page 8).
- One fixed WAN, three fixed LAN, and one configurable LAN/WAN port (pages 6–7).
- AC mode: supported (page 13).
- Router-mode management: 32 AP/NBS-series devices and 128 ES-series devices (page 9).
- AC-mode management: 300 AP/NBS-series devices and 128 ES-series devices (page 9).
- Stateful ACL: supported (page 13).
- IPsec VPN bandwidth: 28 Mbps (page 16).

Catalog decision:
- Add the `controller` capability based on documented AC mode support.
- Omit `controller_specs` because the schema cannot precisely represent
  operating-mode-dependent and AP/NBS-series management limits.
- Do not infer a separate `firewall` capability from stateful ACL alone.
- Do not infer an integrated `switch` capability from VLAN functionality.
- Retain fixed WAN/LAN counts and normal-mode throughput.

## RG-EG305GH-P-E — Verified Integrated Capabilities

Official manufacturer datasheet:
https://eo-sgp-cos.ruijie.com/Document/pdf/2025/12/4/RG-EG305GH-P-E_Datasheet_Official_2025-12-04.pdf

Verified on 2026-11-21.

- Router throughput: 1500 Mbps (page 5).
- One fixed WAN, one fixed LAN, and three configurable LAN/WAN ports (page 3).
- AC mode: supported (page 5).
- Router-mode management: 150 AP/NBS-series devices and 128 ES-series devices (page 11).
- AC-mode management: 500 AP/NBS-series devices and 128 ES-series devices (page 11).
- Stateful firewall: supported (page 12).
- IPsec VPN bandwidth: 170 Mbps (page 13).
- Maximum APs in AC mode: 500 (page 13).
- PoE budget: 60 W; four PoE outputs, IEEE 802.3af/at (page 3).

Catalog decision:
- Add `router`, `firewall`, and `controller` capabilities.
- Add `firewall_specs.vpn_throughput_mbps = 170`.
- Omit firewall throughput because a separately rated value is not published.
- Omit `controller_specs` because the schema cannot precisely model
  operating-mode-dependent and AP/NBS-series management limits.
- Omit `switch_specs` because PoE outputs alone do not establish a
  separately modeled integrated switch.
- Preserve fixed WAN/LAN port counts and documented routing throughput.

## AC5 — Final Integrated Controller Implementation

Manufacturer datasheets confirm AC-mode functionality for all four
Reyee gateways in this catalog.

| SKU | Controller type | Maximum APs (AC mode) |
| --- | --- | ---: |
| RG-EG105G-V3 | integrated | 300 |
| RG-EG105G-P-V3 | integrated | 300 |
| RG-EG305GH-P-E | integrated | 500 |
| RG-EG710XS | integrated | 800 |

Final catalog implementation:
- All four devices have the `controller` capability.
- All four contain `controller_specs` with `controller_type: integrated`.
- `max_managed_aps` records the manufacturer-published AC-mode AP maximum.
- Undocumented managed-switch and managed-gateway limits are omitted.
- The schema does not distinguish AC-mode from router-mode capacities.
  These figures must not be interpreted as verified router-mode limits.
- No `switch_specs` blocks are included because the available evidence
  does not establish a separately modeled integrated switch.
- Consequently, the conditional gateway LAN-port-zero rule is not triggered.

AC5 structural validation: PASS (2026-11-21).

## AC7 — Final Exact-SKU Lifecycle Evidence Matrix

Reviewed: 2026-11-21
Market: International

| SKU | Catalog status | Manufacturer evidence |
| --- | --- | --- |
| RG-EG105G-V3 | active | Named replacement for discontinued V2; current product/datasheet |
| RG-EG105G-P-V3 | active | Named replacement for discontinued V2; current product/datasheet |
| RG-EG305GH-P-E | active | Official product page and datasheet |
| RG-EG710XS | active | Official product page and datasheet |
| RG-ES216GC-V2 | active | Named replacement for discontinued RG-ES216GC |
| RG-ES228GS-LP | active | Official product page |
| RG-NBS5200-24GT4XS-P-V2 | active | Official product page and support documentation |
| RG-RAP2266 | active | Official product page |
| RG-RAP72 | active | Official product page |
| RG-RAP73HD | sunsetting | Official EOS notice: 2026-06-03; last support: 2031-06-03 |

Official lifecycle references:
- https://www.ruijie.com/en-global/support/productLifecycle
- https://www.ruijie.com/en-global/support/xw/rap73hd-eos
- https://www.ruijie.com/en-global/support/xw/eg105g-v2-eg105g-p-v2-eos
- https://www.ruijie.com/en-global/support/xw/es216gc-es224gc-eos

Classification rationale:
- RG-RAP73HD's status and dates are confirmed by an exact-SKU EOS notice.
- The nine active devices have manufacturer product, replacement, or
  support evidence, but no definitive active-sales confirmation in
  the evidence reviewed.
- Product listings and warranty coverage do not independently prove
  that new orders are still accepted.
- Older-model lifecycle dates are never applied to replacement SKUs.
- Unpublished EOS/EOL dates remain null.
- The nine active classifications remain provisional pending
  manufacturer lifecycle or sales confirmation.

AC7 structural validation: PASS.
AC7 complete manufacturer verification: NOT YET CONFIRMED.

## AC7 — Manufacturer Lifecycle Evidence Supplement

Verified: 2026-11-21

Manufacturer lifecycle policy:
https://www.ruijie.com/vi-vn/support/xw/57192

Ruijie states that partners receive one month's EOS notice and that
public EOS announcements are released on the end-of-sale date.

Additional evidence:
- RG-EG105G-V3 / RG-EG105G-P-V3: ReyeeOS430 firmware
  released 2026-10-15.
  https://reyee.ruijie.com/en-global/resources/software/eg-eg105v3-firmware/eg105gv3-430-firmware/
- All nine active catalog SKUs appear in Ruijie's manufacturer
  warranty summary, including RG-EG710XS, RG-RAP2266,
  and RG-NBS5200-24GT4XS-P-V2.
  https://www.ruijie.com/en-global/support/servicepolicy/reyee-consumer-warranty-summary
- RG-ES216GC-V2 is the named replacement for RG-ES216GC.
  https://www.ruijie.com/en-global/support/xw/es216gc-es224gc-eos

Classification decision:
- Retain active for nine devices based on available manufacturer
  product, replacement, firmware, and warranty evidence.
- These sources support the classification but do not guarantee
  current order acceptance.
- Retain null EOS/EOL dates where no exact-SKU dates are published.
- Retain RG-RAP73HD as sunsetting with EOS 2026-06-03 and
  last-support date 2031-06-03.

AC7 assessment: Evidence-supported and ready for QA review,
subject to the team's definition of active lifecycle status.
