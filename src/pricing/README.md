# Price Updater (`src/pricing/`)

CommonJS modules for the weekly price synchronization (NWP-PRICE stories). Tests are in `tests/pricing/` and run with `node --test tests/pricing/*.test.js`.

## Price normalization (NWP-PRICE-003)

Pricing sources are distributor **listing pages**: one URL per vendor and distributor (a store may need several, e.g. one per category), with many products on each page. Every product Firecrawl extracts is normalized and validated before anything is stored.

| File | Purpose |
| --- | --- |
| `price-formats.js` | `parsePrice(raw)`: raw price text → integer centavos and a two-decimal string. `PRICE_FORMAT_EXAMPLES` lists the accepted and rejected formats; the tests run every entry, so the list is the specification. |
| `normalize-record.js` | `buildSkuIndex(devices)` builds the SKU lookup for one vendor's catalog. `normalizeListing(products, source, skuIndex, retrievedAt)` normalizes a whole page; `normalizeRecord(...)` does one product. `normalizeSku()` is the SKU comparison rule. |

### Rules

- **VAT:** prices are stored as listed. Philippine prices are marketed VAT-inclusive, so nothing is added or removed (team decision, 2026-11-19).
- **Currency:** PHP only. One peso marker is accepted, before or after the amount: `₱`, `PHP` or `P` (case-insensitive). Any other currency is rejected.
- **Format:** plain digits or correctly grouped thousands separators (`1,234,567`), up to two decimal places. Surrounding and non-breaking spaces and full-width digits are handled.
- **Never guessed:** ranges, zero, negative amounts, more than two decimals, European separators (`1.234,00`) and extra text (`₱1,234.00 VAT inclusive`, `Call for price`) are rejected. A range is never resolved to one end.
- **Exact arithmetic:** amounts are integer centavos, so `₱1,234.00`, `PHP 1,234` and `1234` all become exactly `1234.00`.
- **SKU match:** a product is matched to a device of the source's vendor when the SKUs are equal after normalization (trim, uppercase, collapse whitespace, full-width to ASCII). Hyphens and suffixes are kept, so `SG2008` never matches `SG2008P`.
- **Same device listed twice:** kept once if the prices agree; rejected if they differ (the page does not say which applies).

### Results

`normalizeListing` returns `{ records, rejected, unmatched }`:

| Field | Meaning |
| --- | --- |
| `records` | One per matched device, ready for `upsertSynchronizedPrice()` (NWP-PRICE-002): `{ deviceId, distributorId, sourceId, price, priceCentavos, retrievedAt, pageSku }`. |
| `rejected` | Products that matched a device (or had no SKU) but can't be used: `missing_field` or `invalid_price`, with a `detail` for `update_log.error`. |
| `unmatched` | Count of products not in the vendor's catalog. Normal on a listing page; not a failure. |

To support a new real-world price format, add it to `PRICE_FORMAT_EXAMPLES` first, then change the parser until the tests pass.
