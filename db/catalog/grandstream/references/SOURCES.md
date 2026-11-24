# Grandstream GWN Hardware Catalog — Sources and Decisions (NWP-SETUP-012)

Vendor: **Grandstream GWN Cloud** (`vendor_id = 5`, per the comment in
`migrations/2026 11 11 erd fields and generic enclosures.sql`).
Research date: 2026-11-21. All specification values come from Grandstream's
own documentation (datasheets, product pages, documentation.grandstream.com
technical-specification pages). Prices are `null` (unknown) until the price
pipeline fills them; `0` is never used as a placeholder.

## Files

| File | Rows | Category |
|---|---|---|
| `grandstream-productlines.json` | 16 (3 gateway, 5 switch, 8 AP) | product_line |
| `grandstream-routers.json` | 7 | gateway_router |
| `grandstream-switches.json` | 24 | switch |
| `grandstream-aps.json` | 12 | ap |
| `grandstream-controllers.json` | not created | see need_controller below |

Every device entry validates against `db/catalog/schema/device-schemas.json`
(draft 2020-12), and every `product_line` resolves to a row in
`grandstream-productlines.json` with unique `(vendor_id, category, name)` and
`(vendor_id, category, line_rank)`.

## need_controller = false

Grandstream does not require a purchased controller:

- GDMS Networking (formerly GWN.Cloud) is a free cloud controller for GWN APs,
  routers, switches and GCC devices.
  https://www.grandstream.com/products/networking-solutions/wi-fi-management/product/gwncloud
  https://documentation.grandstream.com/knowledge-base/gdms-networking-faq/
- GWN Manager (on-premise) is free, with no per-device licences.
  https://documentation.grandstream.com/faq-networking-gdms-gwn-manager
- GWN routers, GCC devices and GWN APs carry an embedded controller at no extra cost.
  https://www.grandstream.com/products/networking-solutions/network-management

So no `grandstream-controllers.json` is authored. **Verify the vendor seed row
for vendor 5 has `need_controller = false`.**

Routers/GCC devices with an embedded controller carry `controller_specs`
(`controller_type: "integrated"`) and the `controller` capability.
Grandstream publishes only AP limits for these embedded controllers, so
`max_managed_switches` is `0` = *no published limit* (not "cannot manage
switches") and `max_managed_gateways` is `1` (the device itself). Because
need_controller is false, the engine does not size controllers for this vendor.

## Lifecycle

Grandstream publishes no dated EOS/EOL milestones (see
`src/types/engine/lifecycle-rules.js`, "Grandstream GWN Cloud"). Every SKU in
this catalog is currently listed on grandstream.com with a current datasheet,
so all are `"active"` with `eos_date`/`eol_date` = `null`. Models already
discontinued (e.g. GWN7600, GWN7610) were left out instead of being seeded as
discontinued.

## Modelling conventions (read before editing)

1. **Gateway WAN/LAN split.** `wan_ports + lan_ports` = total physical ports.
   - GWN700x: `wan_ports` = factory-default WAN ports from the user manual
     (GWN7001: Ethernet 1; GWN7002: Ethernet 3 + SFP 1; GWN7003: Ethernet 9 + SFP 11).
     All ports are WAN/LAN configurable, but Grandstream publishes no maximum WAN count.
   - GCC: `wan_ports` = Grandstream's published maximum WAN (GCC6010/6011/6020: 3; GCC6021: 5).
     The remaining ports are the integrated switch.
2. **GCC integrated switch.** GCC devices are marketed as router + NGFW + PBX + switch with a
   published switching capacity, so they carry `switch_specs` and `lan_ports: 0`
   (schema rule). The LAN port mix assumes the WAN ports are taken from non-PoE ports first:
   - GCC6010: WAN = 2 SFP + 1 GbE → LAN 4 GbE PoE.
   - GCC6011: WAN = 3 GbE (fixed WAN, port numbers not published) → LAN 7 GbE (4 PoE) + 2 SFP.
   - GCC6020: WAN = 1 SFP+ + 2 copper → LAN 3 copper PoE.
   - GCC6021: WAN = SFP+ port 28 (fixed) + 4 copper → LAN 20 copper PoE + 3 SFP+.
   These are counting assumptions, not published port maps; re-check against the
   hardware if a deployment depends on exact port numbering.
   GWN7002/GWN7003 have only 2 small PoE-out ports, so (like Omada ER706WP-4G) they use
   plain `lan_ports` without `switch_specs`.
3. **Firewall specs.** Only gateways with a published security throughput get `firewall_specs`
   and the `firewall` capability. GWN700x have a built-in firewall but Grandstream publishes
   no firewall/IPS throughput, so they have neither (the engine flags rather than guesses).
   For GCC, `firewall_throughputs_mbps` = the published IDS/IPS (GCC601x) or NGFW DPI+IPS
   (GCC602x) figure, following the Omada precedent of using the IPS figure when no separate
   firewall throughput is published.
4. **ha_capability.** `true` only for GCC6021 (2 dedicated HA ports). `null` (unknown) for all
   others: Grandstream documents WAN failover but no HA pair for them.
5. **SFP on mixed-speed switches.** One `sfp_form_factor` per device, so `sfp_ports` counts the
   highest-speed uplinks only (GWN7830: 4 SFP+; GWN7831: 4 SFP+). The 1G SFP ports stay in
   `port_count` and are named in `description`. `copper_ports` is always set explicitly.
6. **PoE.** Switch `poe_standard` = highest standard supplied (802.3bt 60 W ports → `bt3`).
   AP `poe_standard` = minimum needed for the published max draw (≤12.95 W → `af`,
   ≤25.5 W → `at`, above → `bt3`).
7. **AP data rate.** `max_data_rate_mbps` = sum of Grandstream's published per-band maximum
   PHY rates (decimals truncated). Exception: GWN7672 uses the advertised BE11000 aggregate
   because its 6 GHz rate is not published. "500+"/"750+" clients are stored as 500/750.
8. **Rack units.** Rack-mountable 44 mm chassis → `u_height: 1`. Desktop/wall-only → `false`/`0`.
9. **max_power_draw_w** is set only where Grandstream publishes a maximum consumption
   (APs, GWN7712P/7713P). PSU or adapter ratings are not used as a substitute.

## Product-line ladders

- **gateway_router:** GWN700x (1) → GCC601x (2) → GCC602x (3), ranked on published routing,
  VPN and IPS throughput. Team-derived.
- **switch:** follows Grandstream's own series naming L2 Lite → L2+ → L3 → L3 Aggregation.
  Placing GWN7721 (L2 Lite, multi-gig) between GWN771x and GWN780x is a team judgement.
- **ap:** Wi-Fi standard first, then `max_data_rate_mbps`. Team-derived.

## Scope exclusions

- Unmanaged switches (GWN7700/GWN7700M/GWN7701 series): no cloud management.
- Wi-Fi routers (GWN7052/F, GWN7062 family, GWN7072) and GCC6010W: integrated Wi-Fi radios
  cannot be expressed on a gateway entry in the current schema.
- GWN7800 Pro, GWN7721PE, GWN7710R, wall-plate/in-wall and mesh-extender APs (GWN7661,
  GWN7660EM, GWN7670WM), and Wi-Fi 5 APs: left out to keep this first cut to current,
  ceiling/outdoor business models with complete published specs. Add in a follow-up if needed.

## Source pages per SKU

### Routers / convergence gateways
- GWN7001 / GWN7002 / GWN7003 — https://documentation.grandstream.com/knowledge-base/gwn700x-user-guide/ ;
  https://www.grandstream.com/products/networking-solutions/routers/product/gwn7001_gwn7002_gwn7003
- GCC6010 / GCC6011 — https://documentation.grandstream.com/knowledge-base/gcc60xx-user-manual/ ;
  https://www.grandstream.com/products/convergence-solutions/gcc6010-series
- GCC6020 / GCC6021 — https://documentation.grandstream.com/knowledge-base/gcc6020-user-manual-home/

### Switches
- GWN7711(P) — https://www.grandstream.com/hubfs/Product_Documentation/GWN7711(P)/Datasheet_GWN7711(P)_English.pdf ;
  https://www.grandstream.com/products/networking-solutions/network-switches/product/gwn7711pseries
- GWN7712P / GWN7713P — https://www.grandstream.com/hubfs/Product_Documentation/GWN7712P_GWN7713P/Datasheet_GWN7712P13P_English%20Folder.pdf
- GWN7721(P) — https://www.grandstream.com/hubfs/Product_Documentation/GWN7721(P)/Datasheet_GWN7721(P)_English.pdf
- GWN7801(P) / GWN7802(P) / GWN7803(P) — https://documentation.grandstream.com/knowledge-base/gwn780x-series-technical-specifications/ ;
  https://www.grandstream.com/products/networking-solutions/network-switches/product/gwn7801p_gwn7802p_gwn7803p
- GWN7806(P) — https://www.grandstream.com/products/networking-solutions/network-switches/product/gwn7806p
- GWN7811(P) / GWN7812P / GWN7813(P) — https://documentation.grandstream.com/knowledge-base/gwn781x-series-technical-specifications/ ;
  https://www.grandstream.com/products/networking-solutions/network-switches/product/gwn7811p_gwn7812p_gwn7813p
- GWN7816(P) — https://www.grandstream.com/products/networking-solutions/network-switches/product/gwn7816p
- GWN7830 / GWN7831 / GWN7832 — https://documentation.grandstream.com/knowledge-base/gwn783x-series-technical-specifications/ ;
  https://www.grandstream.com/products/networking-solutions/network-switches/product/gwn7830-gwn7831-gwn7832

### Access points
- GWN7660 — https://documentation.grandstream.com/knowledge-base/gwn7660-technical-specifications/
- GWN7660LR — https://documentation.grandstream.com/knowledge-base/gwn7660lr-technical-specifications/
- GWN7660E — https://documentation.grandstream.com/knowledge-base/gwn7660e-technical-specifications/
- GWN7662 — https://documentation.grandstream.com/knowledge-base/gwn7662-technical-specifications/
- GWN7664 — https://documentation.grandstream.com/knowledge-base/gwn7664-technical-specifications/
- GWN7664LR — https://documentation.grandstream.com/knowledge-base/gwn7664lr-technical-specifications/
- GWN7664E — https://documentation.grandstream.com/knowledge-base/gwn7664e-technical-specifications/
- GWN7670 — https://documentation.grandstream.com/knowledge-base/gwn7670-technical-specifications/
- GWN7670E — https://documentation.grandstream.com/knowledge-base/gwn7670e-technical-specifications/ (preliminary) ;
  https://www.grandstream.com/products/networking-solutions/indoor-wifi-access-points/product/gwn7670e
- GWN7670LR — https://documentation.grandstream.com/knowledge-base/gwn7670lr-technical-specifications/
- GWN7672 — https://documentation.grandstream.com/knowledge-base/gwn7672-technical-specifications/
- GWN7674 — https://documentation.grandstream.com/knowledge-base/gwn7674-technical-specifications/

## Values that QA should double-check

- GWN7801P PoE budget: datasheet/product page say 120 W; the newer doc-site table shows 130 W. 120 W used (lower).
- GCC6010/6011 routing: doc site 2.5 Gbps; an older datasheet says 3 Gbps. 2.5 Gbps used (lower).
- GWN7670E: preliminary spec sheet (512 clients / 16 W) vs product page (512 clients / 17 W). Both list 512 clients; higher power draw used.
- GWN7003 `u_height: 1`: rack kit is included but the chassis height is not published.

## SETUP-013 database integration handoff

The intended Grandstream vendor configuration is:

- Vendor name: Grandstream GWN Cloud
- need_controller: false
- management_modes: ['dashboard']

SETUP-012 creates catalog files only and does not modify the vendor table.

Before importing devices, SETUP-013 must verify these values
against the actual database. The distributor seed inserts new
vendors with need_controller = false but does not update existing
vendor records.

The vendor_id = 5 mapping must also be verified against the
target database before insertion.