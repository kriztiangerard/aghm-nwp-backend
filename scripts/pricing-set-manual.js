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

const USAGE = 'Usage: npm run pricing:set-manual -- --vendor "<vendor>" --sku <sku> --distributor <id> --price <amount> [--dry-run]';

class DryRun extends Error {}

/** refreshDeviceMedians from NWP-PRICE-008, or null while that story isn't merged. */
function loadRefreshMedians() {
  try {
    // eslint-disable-next-line global-require
    return require('../src/pricing/median').refreshDeviceMedians || null;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && /src[\\/]pricing[\\/]median/.test(error.message)) return null;
    throw error;
  }
}

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

  const refreshMedians = loadRefreshMedians();
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
  console.log(`  device median: ${result.medianRefreshed ? 'recalculated' : 'NOT recalculated (NWP-PRICE-008 is not merged yet)'}`);
  if (values['dry-run']) console.log('Dry run: nothing was saved.');
}

main()
  .catch((error) => {
    console.error(error instanceof ManualPriceError ? `pricing:set-manual: ${error.message}` : `pricing:set-manual failed: ${error.message}`);
    if (error instanceof ManualPriceError) console.error(USAGE);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));