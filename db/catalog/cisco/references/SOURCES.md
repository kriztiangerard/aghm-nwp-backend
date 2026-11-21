# Cisco Business catalog sources

Lifecycle snapshot as of 2026-11-21. For each selected SKU, the end-of-sale
milestone populates `eos_date` and Cisco's Last Date of Support populates
`eol_date`. An SKU is sunsetting once sales end and discontinued once support
ends. Active entries have no applicable dated bulletin found for the selected SKU.
This is a starter catalog of selected order IDs. Regional variants can have
different dates, power accessories, and radio approvals. Verify the order ID
against local distribution before treating a row as a purchasable option.

## Gateways

| SKUs | Hardware source | Lifecycle source |
| --- | --- | --- |
| RV160-K9-NA | [RV160 datasheet](https://www.cisco.com/c/en/us/products/collateral/routers/rv160-vpn-router/datasheet-c78-741410.html) | [RV160/RV260 bulletin](https://www.cisco.com/c/en/us/products/collateral/routers/small-business-rv-series-routers/eos-eol-notice-c51-2655972.html) |
| RV260-K9-NA | [RV260 datasheet](https://www.cisco.com/c/en/us/products/collateral/routers/rv260-vpn-router/datasheet-c78-741409.html) | [RV160/RV260 bulletin](https://www.cisco.com/c/en/us/products/collateral/routers/small-business-rv-series-routers/eos-eol-notice-c51-2655972.html) |
| RV340-K9-NA, RV345-K9-NA | [RV340 family datasheet](https://www.cisco.com/c/en/us/products/collateral/routers/small-business-rv-series-routers/datasheet-c78-742350.html), [model comparison](https://www.cisco.com/c/en/us/support/smb/product-support/small-business/routers-rv340-comparison.html) | [RV340/RV345 bulletin](https://www.cisco.com/c/en/us/products/collateral/routers/small-business-rv-series-routers/small-business-rv340-rv345-series-eol.html) |

Cisco's NAT throughput is the published firewall forwarding benchmark used for
both throughput fields. IPsec throughput supplies the separate VPN value.
RV260 figures are published as 800+ and 75+ Mbps and stored as their integer
lower bounds. The RV160 and RV260 combo WAN interfaces each count as one WAN with
one SFP option. Integrated LAN switch ports are recorded only in `switch_specs`.
The selected routers have passed their support dates.

## Switches

| SKU | Hardware source | Lifecycle source |
| --- | --- | --- |
| CBS110-8PP-D-NA | [CBS110 datasheet](https://www.cisco.com/c/en/us/products/collateral/switches/business-110-series-unmanaged-switches/datasheet-c78-744158.html), [hardware revision power comparison](https://www.cisco.com/c/en/us/td/docs/switches/lan/csbss/110-switches/Comparison_Guide/cbs110-comparison.html) | No applicable SKU bulletin found |
| CBS250-24P-4G-NA | [CBS250 datasheet](https://www.cisco.com/c/en/us/products/collateral/switches/business-250-series-smart-switches/nb-06-bus250-smart-switch-ds-cte-en.html) | [CBS250 select models bulletin](https://www.cisco.com/c/en/us/products/collateral/switches/business-250-series-smart-switches/business-cbs250-series-switch-mod-eol.html) |
| CBS350-24P-4G-NA | [CBS350 datasheet](https://www.cisco.com/c/en/us/products/collateral/switches/business-350-series-managed-switches/datasheet-c78-744156.html) | [CBS350 select models bulletin](https://www.cisco.com/c/en/us/products/collateral/switches/business-350-series-managed-switches/business-350-series-switches-mod-eol.html) |

Switch draw uses published figures with PoE load. The CBS110 row uses the
higher of the two hardware revisions in Cisco's 110 V comparison. The CBS250
is classified as Layer 3 because Cisco documents static routing on the series.

## Access points

| SKU | Hardware source | Lifecycle source |
| --- | --- | --- |
| CBW140AC-A | [140AC datasheet](https://www.cisco.com/c/en/us/products/collateral/wireless/business-100-series-access-points/smb-01-bus-140ac-ap-ds-cte-en.html) | [140AC bulletin](https://www.cisco.com/c/en/us/products/collateral/wireless/business-100-series-access-points/business-140ac-ap-power-injectors-eol.html) |
| CBW240AC-A | [240AC datasheet](https://www.cisco.com/c/en/us/products/collateral/wireless/business-200-series-access-points/smb-01-bus-240ac-ap-ds-cte-en.html) | [240AC bulletin](https://www.cisco.com/c/en/us/products/collateral/wireless/business-200-series-access-points/Business-240ac-access-points-eol.html) |
| CBW150AX-A-EU | [150AX datasheet and Philippine order ID](https://www.cisco.com/c/en/us/products/collateral/wireless/business-100-series-access-points/business-access-point-ds.html) | [Cisco Business 100 Series bulletin index](https://www.cisco.com/c/en/us/products/wireless/business-100-series-access-points/eos-eol-notice-listing.html) |

The AP rate is a PHY figure. The 140AC row sums the published per-band peaks,
the 240AC row uses Cisco's stated 802.11ac maximum, and the 150AX row uses
Cisco's published dual-band PHY figure. Cisco documents that the 150AX family
cannot share a management network with the 140AC/240AC family.

## Catalog mapping

The repo's catalog identifies Cisco Business as vendor 6 with `needController:
false`. Cisco Business Wireless can use a primary AP for management, and none
of the selected gateways has a documented integrated network controller.
[See Cisco's wireless support guide](https://www.cisco.com/c/en/us/support/smb/product-support/small-business/wireless-mesh-100-200-series.html).

The catalog follows the Aruba device-file layout and uses the shared
product-line schema. Prices are null pending distributor pricing. Optional
specs with no documented value are omitted.
