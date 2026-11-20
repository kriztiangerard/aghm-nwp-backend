'use strict';

// NWP-PRICE-002: what Firecrawl extracts from a distributor listing page.
//
// Firecrawl's JSON format takes a JSON Schema and returns data in that shape, so no site-specific parsing
// code is needed. The descriptions steer the extraction; tune them against real pages
// (npm run pricing:smoke -- <url>) rather than adding per-site code.
//
// `sku` must be the MANUFACTURER model number (ER605, CBS350-24T-4G, RG-ES205GC), because products are
// matched to the catalog by SKU (normalizeListing, NWP-PRICE-003). `price` is the price text exactly as
// shown; parsing it is the normalizer's job, so the extractor must not convert or tidy it.

const LISTING_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    products: {
      type: 'array',
      description: 'Every product listed on this page, in page order. Include sold-out products that still show a price.',
      items: {
        type: 'object',
        properties: {
          sku: {
            type: 'string',
            description:
              'Manufacturer model number or part number of the product (for example ER605, EAP650, U6-Pro, '
              + 'CBS350-24T-4G, RG-ES205GC), usually found in the product name or a "Model"/"SKU"/"P/N" field. '
              + 'Not the store\'s own item code or barcode. Copy it exactly as shown.',
          },
          name: {
            type: 'string',
            description: 'Product name exactly as shown.',
          },
          price: {
            type: 'string',
            description:
              'The current selling price exactly as shown, including the currency symbol (for example "₱12,950.00"). '
              + 'If a sale price and a crossed-out regular price are both shown, give the sale price. '
              + 'The amount only, no other words.',
          },
        },
        required: ['sku', 'price'],
      },
    },
  },
  required: ['products'],
});

/**
 * Returns the extracted product list, or null when the JSON has no `products` array.
 * An empty array is returned as-is; the caller treats it as empty content.
 *
 * @param {*} json  `result.json` from scrapeProductPage()
 * @returns {Array<object> | null}
 */
function readProducts(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  return Array.isArray(json.products) ? json.products : null;
}

module.exports = {
  LISTING_SCHEMA,
  readProducts,
};
