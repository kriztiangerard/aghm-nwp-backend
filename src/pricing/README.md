# Price Updater (`src/pricing/`)

CommonJS modules for the weekly price synchronization (NWP-PRICE stories). They run in the `PriceUpdaterFunction` Lambda, which the weekly Step Functions workflow invokes (NWP-PRICE-011), and in local scripts.

Tests are in `tests/pricing/` and run with `node --test tests/pricing/*.test.js` (also in CI).

## Files

| File | Story | Purpose |
| --- | --- | --- |
| `handler.js` | 010 | Lambda entry point. Dispatches on `event.action`: `probe`, `plan`, `process`, `markBatchFailed`, `finalize`. Actions not built yet throw `NotImplementedError` naming their story. |
| `config.js` | 010 | `loadPricingConfig()`: reads `FIRECRAWL_CONCURRENCY` and `PRICE_MEDIAN_INCLUDE_STALE`; a malformed value throws. |
| `probe.js` | 010 | `probeOutbound()`: one unauthenticated GET to the Firecrawl API host to prove outbound HTTPS works (no key, no credits). |
| `db.js` | 010 | Reuses the engine's database pool; `withTransaction()`. |
| `firecrawl-client.js` | 007 | Calls the Firecrawl v2 REST API (JSON extraction, `maxAge` 0, location PH) and returns a typed success or failure. |
| `firecrawl-errors.js` | 007 | Error types: `timeout`, `rate_limited`, `blocked`, `invalid_url`, `http_error`, `empty_content`, `auth_error`, `quota_exceeded`, `network_error`. |
| `firecrawl-secret.js` | 007, 010 | `getFirecrawlApiKey()`: the key from Secrets Manager (`FIRECRAWL_SECRET_ARN`) or `.env` (`FIRECRAWL_API_KEY`), cached, with short timeouts. |
| `price-formats.js` | 003 | `parsePrice(raw)`: raw price text → integer centavos. `PRICE_FORMAT_EXAMPLES` is the specification. |
| `normalize-record.js` | 003 | `buildSkuIndex()`, `normalizeListing()`, `normalizeRecord()`, `normalizeSku()`. |
| `indicators.md` | — | Draft wording for the BOM notices shown to users (pricing disclaimer, staleness, PoE budget, rack space, controller, lifecycle). |

## Setup

### Firecrawl API key (once per AWS account)

Put only the key in a file, create the secret, then delete the file:

```bash
aws secretsmanager create-secret --name aghm-nwp/firecrawl --secret-string file://firecrawl-key.txt
rm firecrawl-key.txt
```

The value may be the key alone or JSON with an `apiKey` field. For local runs, put `FIRECRAWL_API_KEY=...` in `.env` (never committed).

### Pricing sources

Sources are distributor **listing pages**, one `pricing_source` row per page URL (a store may need several, e.g. one per category). They are seeded separately from the deploy:

1. Apply `db/migrations/004_pricing_sync_schema.sql` (NWP-PRICE-009) if it isn't applied yet.
2. Run `scripts/deactivate-replaced-sources.sql` to turn off retired URLs.
3. Run `npx tsx scripts/seed-distributor-sources.ts`. It's safe to run again; existing rows are skipped.

Grandstream GWN Cloud has no scraped sources (no Philippine store lists it with prices), so its prices are entered manually.

### Local check

`npm run pricing:smoke` scrapes one listing page with your `.env` key and prints what Firecrawl extracted. Each run spends Firecrawl credits (JSON extraction costs 5 credits per page).

## Deployed function

`PriceUpdaterFunction` is defined in `lib/aghm-nwp-stack.ts`. It runs in the same two subnets and security group as the engine Lambdas.

### Network

Those subnets have no direct internet route; their route table sends `0.0.0.0/0` to the **fck-nat** instance, which is normally stopped. So:

- **Firecrawl** is reachable only while fck-nat is running. The weekly workflow starts it before scraping and stops it afterwards.
- **Secrets Manager** is reachable through fck-nat, or through a Secrets Manager VPC endpoint if the VPC has one. Key reads time out after a few seconds instead of hanging.

### Check after deploying (fck-nat running)

```bash
aws lambda invoke --function-name <PriceUpdaterFunctionName output> \
  --cli-binary-format raw-in-base64-out --payload '{"action":"probe"}' probe.json
```

A working setup returns `"ok": true`, an HTTP status and `"firecrawlKey": "readable"` in `probe.json`; the key itself is never returned. Failures:

| Error | Meaning | Fix |
| --- | --- | --- |
| `ProbeFailedError` | No outbound access | Start fck-nat and try again (the workflow retries this one) |
| `SecretUnavailableError` | The key can't be read | The message names the cause: the secret is missing, access is denied, or Secrets Manager is unreachable |

### Settings (`lib/aghm-nwp-stack.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FIRECRAWL_CONCURRENCY` | `2` | Pages scraped at once. Keep it at or below the Firecrawl plan's concurrent browsers (Free 2, Hobby 5); extra requests only queue. |
| `PRICE_MEDIAN_INCLUDE_STALE` | `false` | Whether stale synchronized prices join the median when at least one fresh price exists (NWP-PRICE-008). |

## Price normalization (NWP-PRICE-003)

Every product Firecrawl extracts from a listing page is normalized and validated before anything is stored.

### Rules

- **VAT:** prices are stored as listed. Philippine prices are marketed VAT-inclusive, so nothing is added or removed (team decision, 2026-11-19).
- **Currency:** PHP only. One peso marker is accepted, before or after the amount: `₱`, `PHP` or `P` (case-insensitive). Any other currency is rejected.
- **Format:** plain digits or correctly grouped thousands separators (`1,234,567`), up to two decimal places. Surrounding and non-breaking spaces and full-width digits are handled.
- **Never guessed:** ranges, zero, negative amounts, more than two decimals, European separators (`1.234,00`) and extra text (`₱1,234.00 VAT inclusive`, `Call for price`, `from ₱18,825.00`) are rejected. A range is never resolved to one end.
- **Exact arithmetic:** amounts are integer centavos, so `₱1,234.00`, `PHP 1,234` and `1234` all become exactly `1234.00`.
- **SKU match:** a product is matched to a device of the source's vendor when the SKUs are equal after normalization (trim, uppercase, collapse whitespace, full-width to ASCII). Hyphens and suffixes are kept, so `SG2008` never matches `SG2008P`.
- **Same device listed twice:** kept once if the prices agree; rejected if they differ (the page does not say which applies).

### Results

`normalizeListing(products, source, skuIndex, retrievedAt)` returns `{ records, rejected, unmatched }`:

| Field | Meaning |
| --- | --- |
| `records` | One per matched device, ready to store (NWP-PRICE-002): `{ deviceId, distributorId, sourceId, price, priceCentavos, retrievedAt, pageSku }`. |
| `rejected` | Products that matched a device (or had no SKU) but can't be used: `missing_field` or `invalid_price`, with a `detail` for `update_log.error`. |
| `unmatched` | Count of products not in the vendor's catalog. Normal on a listing page; not a failure. |

To support a new real-world price format, add it to `PRICE_FORMAT_EXAMPLES` first, then change the parser until the tests pass.