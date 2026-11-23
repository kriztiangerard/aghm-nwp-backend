'use strict';

// NWP-PRICE-006: lists every device flagged for manual review, with each distributor's latest sync status.
//
//   npm run pricing:review            readable list
//   npm run pricing:review -- --json  the same data as JSON
//
// Needs DATABASE_URL (and DB_SSL=true for RDS) in .env. Read-only.

const { parseArgs } = require('node:util');
const { getPool, closePool } = require('../src/pricing/db');
const { listDevicesNeedingReview } = require('../src/pricing/review');
const { MANUAL_REVIEW_THRESHOLD } = require('../src/pricing/constants');

function formatDate(value) {
  if (!value) return 'never';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').slice(0, 16);
}

function print(devices) {
  if (devices.length === 0) {
    console.log('No devices need manual review.');
    return;
  }
  console.log(`${devices.length} device(s) need manual review (every synchronized source failed ${MANUAL_REVIEW_THRESHOLD}+ runs in a row):\n`);
  devices.forEach((d) => {
    console.log(`${d.vendor}  ${d.sku}  ${d.name}`);
    console.log(`  device price: ${d.price === null ? 'none' : `PHP ${d.price}`} (last verified ${formatDate(d.priceUpdatedAt)})`);
    d.distributors.forEach((line) => {
      const kind = line.manual ? 'manual' : `synchronized, ${line.consecutiveFailures} failure(s) in a row${line.isStale ? ', stale' : ''}`;
      console.log(`  - [${line.distributorId}] ${line.distributor}: PHP ${line.price} (${kind})`);
      if (!line.manual) {
        const latest = line.latestStatus ? `${line.latestStatus} on ${formatDate(line.latestRunAt)}` : 'no sync recorded';
        console.log(`      latest: ${latest}${line.latestError ? ` | ${line.latestError}` : ''}`);
      }
    });
    console.log('');
  });
  console.log('To enter a verified price: npm run pricing:set-manual -- --vendor "<vendor>" --sku <sku> --distributor <id> --price <amount>');
}

async function main() {
  const { values } = parseArgs({ options: { json: { type: 'boolean', default: false } } });
  const pool = await getPool();
  const devices = await listDevicesNeedingReview(pool);
  if (values.json) console.log(JSON.stringify(devices, null, 2));
  else print(devices);
}

main()
  .catch((error) => {
    console.error(`pricing:review failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));