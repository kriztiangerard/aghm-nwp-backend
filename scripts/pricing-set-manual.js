'use strict';

// NWP-PRICE-006: enters a verified price by hand for one device at one distributor.
//
//   npm run pricing:set-manual -- --vendor "TP-Link Omada" --sku ER605 --distributor 3 --price 3450
//   npm run pricing:set-manual -- ... --dry-run     show what would change, then roll back
//
// The row is stored as a manual price (source_id NULL), its stale, failure-count and review state are cleared,
// the device's review flag is re-evaluated and its median price recalculated (NWP-PRICE-008), all in one
// transaction. Find distributor ids with npm run pricing:review. Needs DATABASE_URL (and DB_SSL=true for RDS).

const { parseArgs } = require('node:util');
const { withTransaction, closePool } = require('../src/pricing/db');
const { setManualPrice, ManualPriceError } = require('../src/pricing/manual');
const { refreshDeviceMedians } = require('../src/pricing/median');
const { loadPricingConfig } = require('../src/pricing/config');

const USAGE = 'Usage: npm run pricing:set-manual -- --vendor "<vendor>" --sku <sku> --distributor <id> --price <amount> [--dry-run]';

class DryRun extends Error {}

async function main() {
  const { values } = parseArgs({
    options: {
      vendor: { type: 'string' },
      sku: { type: 'string' },
      distributor: { type: 'string' },
      price: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const distributorId = Number(values.distributor);
  if (!values.vendor || !values.sku || !values.distributor || !values.price || !Number.isInteger(distributorId)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  // The median uses the same stale option as the weekly sync (PRICE_MEDIAN_INCLUDE_STALE, default false).
  const { medianIncludeStale } = loadPricingConfig();
  const refreshMedians = (client, deviceIds) => refreshDeviceMedians(client, deviceIds, { includeStale: medianIncludeStale });
  let result;
  try {
    await withTransaction(async (client) => {
      result = await setManualPrice(client, {
        vendor: values.vendor, sku: values.sku, distributorId, price: values.price,
      }, { refreshMedians });
      if (values['dry-run']) throw new DryRun();
    });
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }

  const verb = values['dry-run'] ? 'Would set' : 'Set';
  console.log(`${verb} ${result.vendor} ${result.sku} (${result.name}) at ${result.distributor} to PHP ${result.price} as a manual price.`);
  console.log(`  previous row: ${result.replaced === 'inserted' ? 'none (new row)' : `${result.replaced} price`}`);
  console.log(`  manual review: ${result.stillNeedsReview ? 'STILL FLAGGED (unexpected; check the device\'s pricing rows)' : 'cleared (a device with a manual price is not flagged)'}`);
  console.log(`  device price: ${result.devicePrice === null ? 'unchanged (no fresh prices)' : `median is now PHP ${result.devicePrice}`}`);
  if (values['dry-run']) console.log('Dry run: nothing was saved.');
}

main()
  .catch((error) => {
    console.error(error instanceof ManualPriceError ? `pricing:set-manual: ${error.message}` : `pricing:set-manual failed: ${error.message}`);
    if (error instanceof ManualPriceError) console.error(USAGE);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));