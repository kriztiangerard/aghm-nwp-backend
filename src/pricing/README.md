# Price Updater (`src/pricing/`)

CommonJS modules for the weekly price synchronization (NWP-PRICE stories). They run in the `PriceUpdaterFunction` Lambda, which the weekly Step Functions workflow invokes (NWP-PRICE-011), and in local scripts.

Tests are in `tests/pricing/` and run with `node --test tests/pricing/*.test.js` (also in CI).

## Files

| File | Story | Purpose |
| --- | --- | --- |
| `handler.js` | 010, 011 | Lambda entry point. Dispatches on `event.action`: `probe`, `plan`, `process`, `markBatchFailed`, `finalize`. |
| `workflow.js` | 011 | The weekly workflow's own steps: `planRun()`, `markBatchFailed()`, `finalizeRun()`. |
| `collect.js` | 002, 004 | `processSourceBatch()`: the `process` action's collection step. Scrapes one batch (with retry and failure isolation), combines its pages, stores found prices, returns a summary. |
| `outcome.js` | 004 | `recordBatchOutcome()` (one `update_log` row per device), `attributeOutcomes()`, `loadTrackedRows()`, `getRunResult()`. |
| `pricing-state.js` | 005, 006 | `markSyncFailure()` (stale, failure count + 1; never inserts, deletes or changes the price), `markSyncSuccess()` (not stale, count 0), `evaluateManualReview()`. |
| `review.js` | 006 | `listDevicesNeedingReview()`, `countDevicesNeedingReview()`, `devicesInRun()`, `buildRunSummary()`. |
| `manual.js` | 006 | `setManualPrice()`, used by `npm run pricing:set-manual`. |
| `median.js` | 008 | `refreshDeviceMedians()`: sets `device.price` to the median of its fresh prices. `computeMedian()` (integer centavos, half-up), `medianForRows()`, `decimalToCentavos()`, `centavosToDecimal()`. |
| `constants.js` | 006 | `MANUAL_REVIEW_THRESHOLD = 3` (SOURCED: manuscript). |
| `sync-status.js` | 004 | `SYNC_STATUS`: the one list of outcomes for pages, devices and `update_log.status`; `RETRYABLE`, `ACCOUNT_LEVEL`. |
| `extraction.js` | 002 | `LISTING_SCHEMA`, the Firecrawl JSON schema for a listing page (`{ products: [{ sku, name, price }] }`), and `readProducts()`. |
| `sources.js` | 002 | `listActiveSources()` and `loadVendorSkuIndex()`. |
| `price-store.js` | 002 | `upsertSynchronizedPrice()`: one `pricing` row per device and distributor; replaces a manual row. |
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
3. Run `npx tsx scripts/seed-distributor-sources.ts`. **Don't run it twice:** it doesn't skip sources that already exist, so a second run adds a copy of every source.
4. Shoppable Business sources: `npm run seed:shoppable-sources` (add `-- --dry-run` first to see what it would do). It's safe to run again: it only adds pages that aren't already there. To add a search or more result pages, edit `searches` in `scripts/seed-shoppable-sources.ts`. Confirm the page parameter in a browser before setting `pages` above 1.

A vendor whose listing spans several pages needs one source row per page URL (see Pagination below). Grandstream GWN Cloud has no scraped sources (no Philippine store lists it with prices), so its prices are entered manually.

### Local check

`npm run pricing:smoke` scrapes one listing page with your `.env` key and prints what Firecrawl extracted. Each run spends Firecrawl credits (JSON extraction costs 5 credits per page).

## Deployed function

`PriceUpdaterFunction` is defined in `lib/aghm-nwp-stack.ts`. It runs in the same two subnets and security group as the engine Lambdas.

### Network

Those subnets have no direct internet route; their route table sends `0.0.0.0/0` to the **fck-nat** instance, which is normally stopped. So:

- **Firecrawl** is reachable only while fck-nat is running. The weekly workflow (NWP-PRICE-011) starts it before scraping and stops it afterwards, if it was stopped.
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

## Price collection (NWP-PRICE-002)

A **batch** is every active source of one vendor and one distributor, so all of a distributor's pages are read before a device can be called missing (NWP-PRICE-004). The weekly workflow (NWP-PRICE-011) invokes the Lambda once per batch:

```json
{ "action": "process", "runAt": "2026-11-23T02:00:00.000Z", "vendorId": 1, "distributorId": 7,
  "sources": [{ "sourceId": 101, "sourceUrl": "https://…?page=1" }, { "sourceId": 102, "sourceUrl": "https://…?page=2" }] }
```

`runAt` is the run's shared start time; every batch of a run passes the same value.

### Steps

1. **Catalog check:** the vendor's devices become a SKU index. A vendor with no devices is skipped without scraping (pages report `skipped`), so it costs no credits.
2. **Scrape:** each page is scraped with `LISTING_SCHEMA`, at most `FIRECRAWL_CONCURRENCY` at once. A failed page reports its error type and the others continue (see Failure handling). No products array is `invalid_response`; an empty list is `empty_content`.
3. **Normalize:** each page goes through `normalizeListing()` (below). Products not in the catalog are counted, not failed.
4. **Combine pages:** a device found on two pages at the same price is stored once (from the first page); at different prices it is stored from neither and reported as `invalid_price`. A usable price on one page wins over a rejection on another.
5. **Store:** each found device in its own transaction: `upsertSynchronizedPrice()` then `markSyncSuccess()`, which clears the row's stale flag (NWP-PRICE-005). A synchronized price replaces a manual one and sets `source_id`. A database error rolls back only that device (`db_error`).
6. **Record:** `recordBatchOutcome()` writes one `update_log` row per device (next section).

### Summary returned

```json
{ "runAt": "…", "vendorId": 1, "distributorId": 7,
  "pages": [{ "sourceId": 101, "status": "success", "productCount": 32, "matched": 14, "unmatched": 18, "rejectedWithoutDevice": 0, "attempts": 1, "creditsUsed": 5 },
            { "sourceId": 102, "status": "blocked", "productCount": 0, "attempts": 1, "message": "…" }],
  "found": [11, 12], "rejected": [{ "deviceId": 13, "reason": "invalid_price", "detail": "…" }],
  "dbErrors": [], "stored": { "inserted": 1, "updated": 1 }, "stoppedBy": null }
```

`found`, `rejected` and `dbErrors` are what `recordBatchOutcome()` uses to record an outcome per device; a device in none of them was not seen on any page. `stoppedBy` is `null`, or `{ status, sourceId, message }` when an account-level error stopped the batch. The `process` action returns this summary plus `outcome: { recorded, byStatus }`.

### Pagination

The scraper reads exactly the URL it is given and never follows links. A store that spreads a vendor over several pages needs one `pricing_source` row per page URL (for example `?page=2`), all with the same vendor and distributor, so they form one batch. Check each listing's page count when adding a source: for example, Wired Systems' Omada collection shows 20 of 32 products per page.

### Tuning the extraction

If a store's products come back without SKUs or with the store's own item codes, adjust the descriptions in `LISTING_SCHEMA` and check with `npm run pricing:smoke -- <url>` (it uses the same schema). Do not add per-site code.

## Failure handling (NWP-PRICE-004)

### Pages

- **Isolation:** each page's scrape, check and normalize step is isolated; a failure (or an unexpected exception, `unexpected_error`) is recorded for that page and the other pages continue.
- **Retry:** `timeout` and `rate_limited` are retried once, after 2 s or the `Retry-After` time (5 s if none, at most 30 s). Nothing else is retried; `blocked` never is.
- **Account-level errors** (`auth_error`, `quota_exceeded`, `network_error`) are not a distributor's fault. The batch stops: pages not yet started are `skipped`, `stoppedBy` is set so the workflow skips the remaining batches (NWP-PRICE-011), and no price is marked stale for it.
- **Logging:** one log line per page: `{ source: "price-updater", event: "page", runAt, sourceId, status, productCount, matched, attempts }`. Pages with no attributed devices (for example on a first run) still show up.

### Devices: one `update_log` row each

`recordBatchOutcome()` loads the distributor's **synchronized** rows for the vendor's devices that were last priced from one of the batch's pages (manual rows never count), and records:

| Device | Status |
| --- | --- |
| Found with a usable price, stored | `success` |
| Found, storing failed | `db_error` |
| Found, price unusable | `invalid_price` or `missing_field` |
| Not found; its page failed | that page's status (`blocked`, `timeout`, …) |
| Not found; its page succeeded | `not_listed` |
| Never priced from this distributor and not found | nothing |

After an account-level stop, unfound devices are not recorded. Every non-success also gets `markSyncFailure()` (see Stale prices). `run_at` is the run's shared `runAt`.

`getRunResult(client, runAt)` reports the run as successful when at least one of its rows is `success`; finalize (NWP-PRICE-011) logs it.

All statuses are in `sync-status.js`. Firecrawl error types and normalizer reasons map onto them by the same string.

## Stale prices (NWP-PRICE-005)

Staleness is stored per `pricing` row, so per device and distributor.

- **Sync fails** (`markSyncFailure()`): the synchronized row is marked `is_stale = TRUE`; its price, `source_id` and `last_updated` stay exactly as they were, so the last verified price is still used. A manual row (`source_id` NULL) is never changed, and a missing row is never created.
- **Sync succeeds** (`markSyncSuccess()`): the new price is stored and `is_stale` is cleared, in the same transaction.
- **Engine:** a device counts as stale only when **every** pricing row is stale (`price-provenance.js`, NWP-ENGINE-006). Its BOM lines then carry `isStale`, and the plan gets the `BOM_PRICE_STALE` advisory with each SKU's last verified date. A device with any fresh or manual row is never shown as stale.
- Nothing in `src/pricing/` deletes `pricing` rows.

## Consecutive failures and manual review (NWP-PRICE-006)

- **Count:** `markSyncFailure()` adds 1 to the row's `consecutive_failure_count` in the same statement that marks it stale; `markSyncSuccess()` resets it to 0. Manual rows are never counted.
- **Flag:** at finalize, `evaluateManualReview(client, devicesInRun(runAt))` sets `needs_manual_review` on each device's synchronized rows to whether **every** synchronized row has a count of at least `MANUAL_REVIEW_THRESHOLD` (3) **and** the device has no manual price. One row below 3, or one manual row, keeps the device unflagged; a success (count 0) clears the flag at the next finalize. Running it twice gives the same result.
- **Run summary:** `buildRunSummary(client, runAt)` returns the run result plus `devicesNeedingReview`; finalize (NWP-PRICE-011) logs it as one JSON line.
- **Review and manual prices:** `npm run pricing:review` and `npm run pricing:set-manual` (see the backend README, "Price Updater: Manual Review"). A manual price is stored with `source_id` NULL and clears that row's stale, count and review state; the device is then re-evaluated and its median recalculated (`refreshDeviceMedians()`, NWP-PRICE-008).

## Median price (NWP-PRICE-008)

`device.price` is the median of the device's `pricing` rows, so one odd listing can't move it.

- **Which rows:** fresh rows only: synchronized rows that aren't stale, plus manual rows (`source_id` NULL), which always count as fresh. With `PRICE_MEDIAN_INCLUDE_STALE=true`, stale synchronized rows join in, but only when at least one fresh row exists.
- **No fresh rows:** `device.price` and `price_updated_at` are left exactly as they are, so the last median stays in use (and the engine shows it as stale). A device with no rows at all keeps `price` NULL.
- **Arithmetic:** in integer centavos. An even count takes the mean of the two middle values; a half centavo rounds up (₱3,450.00 and ₱3,450.01 give ₱3,450.01).
- **Written:** `UPDATE device SET price, price_updated_at` with `price_updated_at` set to the run time (`updatedAt`; finalize, NWP-PRICE-011, passes `runAt`). `pricing` is never changed here.
- **Called by:** `npm run pricing:set-manual` after a manual price, and finalize for every device in the run: `refreshDeviceMedians(client, deviceIds, { includeStale, updatedAt })`, which returns `{ updated: [{ deviceId, price, prices }], unchanged: [deviceId] }`.
- **Provenance:** unchanged. The engine still reports `price_source: 'manual'` for any device with a manual row (`price-provenance.js`, NWP-ENGINE-006).

## Weekly workflow (NWP-PRICE-011)

The `PriceSync` Standard state machine (`lib/price-sync-workflow.ts`) runs every Sunday at 02:00 Asia/Manila (EventBridge Scheduler). Every step invokes this function:

| Step | Event | Returns |
| --- | --- | --- |
| Probe | `{ action: "probe" }` | Retried on `ProbeFailedError` while fck-nat comes up. |
| Plan | `{ action: "plan", runAt }` with `runAt` = `$$.Execution.StartTime` | `{ runAt, batchCount, sourceCount, batches }`: one batch per vendor × distributor, sorted, each with the same `runAt`. |
| Batches (Map) | `{ action: "process", runAt, vendorId, distributorId, sources }` | The batch summary (Price collection, above). The Map runs `FIRECRAWL_PLAN_BROWSERS ÷ FIRECRAWL_PAGES_PER_BATCH` batches at once (`lib/aghm-nwp-stack.ts`). |
| Batch failed | `{ action: "markBatchFailed", batch, error: { Error, Cause } }` | `{ recorded, byStatus, alreadyRecorded }` |
| Finalize | `{ action: "finalize", runAt, stop }` | The run-summary line (below). |

- **A batch that fails as a whole** (Lambda timeout, crash; the Map item's Catch) goes to `markBatchFailed()`. It uses NWP-PRICE-004's attribution: the distributor's synchronized rows for the vendor's devices last priced from one of the batch's pages.
  - Devices with no `update_log` row in this run are recorded as `unexpected_error` ("Batch failed as a whole (…)") and marked failed (`markSyncFailure()`: stale, count + 1).
  - A device whose price was already stored in this run (`last_updated` at or after `runAt`, not stale) is recorded as `success` instead. Prices are stored only after every page is read and combined, so it is correct.
  - Devices already recorded in this run are left alone, so running it twice is safe.
  - A timed-out batch is not retried, so its Firecrawl credits are not spent twice.
- **An account-level stop:** when a batch returns `stoppedBy`, that Map item ends in the `PriceSync.AccountLevelStop` Fail state. That stops the Map, so the remaining batches are skipped. Batches already running finish on their own. The Map's Catch passes the stop to finalize as `stop: { Error, Cause }`, where Cause is the JSON of `stoppedBy`.
- **Finalize** takes its devices from `update_log` (`devicesInRun(runAt)`), not from the batch summaries. Every device a batch reported has a row there, and the summaries are dropped from the workflow state to stay under the 256 KB limit. In one transaction it runs:
  1. `refreshDeviceMedians(…, { includeStale, updatedAt: runAt })` (008);
  2. `evaluateManualReview()` (006);
  3. `buildRunSummary()` (004 and 006).

  It logs one line:

  ```json
  { "source": "price-updater", "event": "run-summary", "runAt": "…", "successful": true, "rows": 52,
    "byStatus": { "success": 47, "blocked": 5 }, "devicesNeedingReview": 0,
    "devices": 30, "mediansUpdated": 28, "mediansUnchanged": 2, "flaggedInRun": 0, "stoppedBy": null,
    "unrecordedDevices": 0, "unrecorded": [] }
  ```
- **Unrecorded outcomes (AC5):** finalize also lists, under `unrecorded`, devices last priced from an active source that have no `update_log` row for the run. There's one entry per vendor × distributor, which is one batch. If `stoppedBy` isn't set, this means a batch's failure was never recorded (for example, `markBatchFailed` itself failed). An `outcomes-missing` error line is logged, and the execution fails. The root README has the recovery steps.
- **The execution fails** when any step fails (after stopping fck-nat, if it started it), when `successful` is false (`PriceSync.NoPriceCollected`), or when outcomes are missing without an account-level stop (`PriceSync.OutcomesMissing`).

## Timestamps

Every timestamp the Price updater writes (`pricing.last_updated`, `update_log.run_at`, `device.price_updated_at`) is stored as **UTC**.

- The columns are `TIMESTAMP` without a time zone (ERD), so they keep whatever wall-clock time they're given.
- The code therefore always sends UTC ISO strings (`toISOString()`), never JavaScript `Date` objects. node-pg would send a `Date` in the machine's local time, so a run or a `pricing:set-manual` from a PH-time laptop would store PH time, while the Lambda stores UTC.
- Read them as UTC. In PH time, a run at Sunday 02:00 shows as Saturday 18:00.

## Price normalization (NWP-PRICE-003)

Every product Firecrawl extracts from a listing page is normalized and validated before anything is stored.

### Rules

- **VAT:** prices are stored as listed. Philippine prices are marketed VAT-inclusive, so nothing is added or removed (team decision, 2026-11-19).
- **Currency:** PHP only. One peso marker is accepted, before or after the amount: `₱`, `PHP` or `P` (case-insensitive). Any other currency is rejected.
- **Format:** plain digits or correctly grouped thousands separators (`1,234,567`), up to two decimal places. Surrounding and non-breaking spaces and full-width digits are handled.
- **Never guessed:** zero, negative amounts, more than two decimals, European separators (`1.234,00`) and extra text (`₱1,234.00 VAT inclusive`, `Call for price`, `from ₱18,825.00`) are rejected.
- **Ranges:** a listing price shown as a range (`₱1,000 - ₱1,200`, usually a product with variants) stores the **higher** end (decision by G, 2026-11-26: the conservative figure for a budget estimate). Both ends must be valid PHP amounts, or the price is rejected. A lower bound alone (`from ₱18,825.00`) is still rejected. Manual prices (`pricing:set-manual`) never accept a range. `RANGE_EXAMPLES` in `price-formats.js` is the specification.
- **Exact arithmetic:** amounts are integer centavos, so `₱1,234.00`, `PHP 1,234` and `1234` all become exactly `1234.00`.
- **SKU match:** a product is matched to a device of the source's vendor in three steps:
  1. **Exact,** after normalization (trim, uppercase, collapse whitespace, full-width to ASCII).
  2. **Ignoring separators** (spaces, hyphens, underscores, dots, slashes): `U6-PRO` = `U6 Pro` = `u6pro`.
  3. **Also ignoring a leading brand prefix** (`TL-`, `TP-Link`, `UBNT-`, `UniFi`, `RG-`, `Ruijie`, `Reyee`, `Cisco`, `HPE`, `Aruba`) on both sides: `TL-SG2008` finds `SG2008`, and `RAP2266` finds `RG-RAP2266`.

  Steps 2 and 3 match only when exactly one catalog device fits. TP-Link reuses base model numbers (`SG3428XPP-M2` and `TL-SG3428XPP-M2` are different switches), so an ambiguous spelling is counted as unmatched, never guessed. Letters and digits are never dropped (`SG2008` never matches `SG2008P`), and region or version suffixes (`(UN)`, `-NA`, `V2`) aren't stripped.
- **Same device listed twice:** kept once if the prices agree; rejected if they differ (the page does not say which applies).

### Results

`normalizeListing(products, source, skuIndex, retrievedAt)` returns `{ records, rejected, unmatched }`:

| Field | Meaning |
| --- | --- |
| `records` | One per matched device, ready to store (NWP-PRICE-002): `{ deviceId, distributorId, sourceId, price, priceCentavos, retrievedAt, pageSku }`. |
| `rejected` | Products that matched a device (or had no SKU) but can't be used: `missing_field` or `invalid_price`, with a `detail` for `update_log.error`. |
| `unmatched` | Count of products not in the vendor's catalog. Normal on a listing page; not a failure. |

To support a new real-world price format, add it to `PRICE_FORMAT_EXAMPLES` first, then change the parser until the tests pass.