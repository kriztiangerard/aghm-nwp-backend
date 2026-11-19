#!/usr/bin/env node
'use strict';

// NWP-PRICE-007 manual verification: scrape one real distributor product page through the wrapper.
//
// Usage (Node 20.6+ loads .env with --env-file):
//   node --env-file=.env scripts/firecrawl-smoke.js <product-url> [country]
//   npm run pricing:smoke -- <product-url>
//
// Prints the wrapper's result as JSON. The API key is never printed.
// Each run spends Firecrawl credits (JSON format: 5 credits per page at the time of writing).
//
// The schema below is PROVISIONAL, only for this check. The real extraction schema is owned by
// NWP-PRICE-002 (src/pricing/extraction.js).

const { scrapeProductPage } = require('../src/pricing/firecrawl-client');

const SMOKE_SCHEMA = {
  type: 'object',
  properties: {
    sku: {
      type: 'string',
      description: 'Manufacturer model or part number of the product on this page, exactly as shown.',
    },
    price: {
      type: 'string',
      description: 'Listed selling price exactly as shown on the page, including any currency symbol.',
    },
  },
  required: ['sku', 'price'],
};

async function main() {
  const [url, country] = process.argv.slice(2);
  if (!url) {
    console.error('Usage: node --env-file=.env scripts/firecrawl-smoke.js <product-url> [country]');
    process.exit(2);
  }

  const startedAt = Date.now();
  const result = await scrapeProductPage(url, { schema: SMOKE_SCHEMA, country });
  const elapsedMs = Date.now() - startedAt;

  console.log(JSON.stringify({ url, elapsedMs, result }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`Smoke check crashed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
