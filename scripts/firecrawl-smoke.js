#!/usr/bin/env node
'use strict';

// NWP-PRICE-007 manual verification: scrape one real distributor listing page through the wrapper.
//
// Usage (Node 20.6+ loads .env with --env-file):
//   node --env-file=.env scripts/firecrawl-smoke.js <listing-page-url> [country]
//   npm run pricing:smoke -- <listing-page-url>
//
// Prints the wrapper's result as JSON, plus a count of extracted products. The API key is never printed.
// Each run spends Firecrawl credits (JSON format: 5 credits per page at the time of writing).
//
// The schema below is PROVISIONAL, only for this check. The real extraction schema is owned by
// NWP-PRICE-002 (src/pricing/extraction.js).

const { scrapeProductPage } = require('../src/pricing/firecrawl-client');

const SMOKE_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      description: 'Every product listed on this page.',
      items: {
        type: 'object',
        properties: {
          sku: {
            type: 'string',
            description: 'Manufacturer model number of the product (for example ER605 or CBS250-8T-D), exactly as shown. Not the store\'s own item code.',
          },
          name: { type: 'string', description: 'Product name as shown.' },
          price: {
            type: 'string',
            description: 'Listed selling price exactly as shown, including any currency symbol. The amount only, no other text.',
          },
        },
        required: ['sku', 'price'],
      },
    },
  },
  required: ['products'],
};

async function main() {
  const [url, country] = process.argv.slice(2);
  if (!url) {
    console.error('Usage: node --env-file=.env scripts/firecrawl-smoke.js <listing-page-url> [country]');
    process.exit(2);
  }

  const startedAt = Date.now();
  const result = await scrapeProductPage(url, { schema: SMOKE_SCHEMA, country });
  const elapsedMs = Date.now() - startedAt;
  const productCount = result.ok && Array.isArray(result.json.products) ? result.json.products.length : 0;

  console.log(JSON.stringify({ url, elapsedMs, productCount, result }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`Smoke check crashed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
