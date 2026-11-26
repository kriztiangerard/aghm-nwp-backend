// Registers Shoppable Business (business.shoppable.ph) listing pages as pricing sources (NWP-PRICE-001).
//
//   npm run seed:shoppable-sources              # insert what is missing
//   npm run seed:shoppable-sources -- --dry-run  # show what would be inserted, change nothing
//
// Team decisions (G, 2026-11-26):
// - Shoppable Business is accepted as a distributor (a PH-based B2B marketplace).
// - Its prices are treated as VAT-inclusive as listed (PH rules require digital storefronts to show
//   VAT-inclusive prices); nothing is added or removed.
// - Listings with variants show a price range; the normalizer stores the higher end (price-formats.js).
//
// Safe to run again: a source is inserted only if the same vendor, distributor and URL is not already
// there, and everything runs in one transaction on one connection. Vendors must already exist (they come
// from db/migrations/004_vendor_ids.sql); the script stops instead of creating a misspelled vendor. The
// distributor is created if it is missing.
//
// Pagination: the scraper reads exactly the URL it is given, so every results page needs its own row.
// Set `pages` per search once the real page count is known; page N is the search URL plus
// `&${PAGE_PARAM}=N`. Confirm the parameter name in a browser (click "next" and read the address bar)
// before raising any `pages` above 1. Each page costs 5 Firecrawl credits per weekly run.

import { pool } from "../src/db/client";

const DISTRIBUTOR_NAME = "Shoppable Business";
const SEARCH_URL = "https://business.shoppable.ph/search";
const PAGE_PARAM = "page"; // confirm in a browser before using pages > 1

type ShoppableSearch = {
  vendorName: string; // must match vendor.name exactly
  query: string;      // the search text, as in ?q=
  pages: number;      // results pages to register (1 = the first page only)
};

const searches: ShoppableSearch[] = [
  { vendorName: "TP-Link Omada", query: "Omada", pages: 1 },
  { vendorName: "Ruijie", query: "Reyee", pages: 1 },
  { vendorName: "Ubiquiti UniFi", query: "Ubiquiti", pages: 1 },
  // "HPE" also returns servers and storage; they are only counted as unmatched, but every page costs credits.
  { vendorName: "HPE Aruba Instant On", query: "HPE", pages: 1 },
  // More searches go here, for example:
  // { vendorName: "Cisco Business", query: "Cisco Business", pages: 1 },
];

function pageUrls(search: ShoppableSearch): string[] {
  if (!Number.isInteger(search.pages) || search.pages < 1) {
    throw new Error(`pages must be a positive integer (${search.vendorName}, "${search.query}").`);
  }
  const first = `${SEARCH_URL}?q=${encodeURIComponent(search.query)}`;
  const urls = [first];
  for (let page = 2; page <= search.pages; page += 1) urls.push(`${first}&${PAGE_PARAM}=${page}`);
  return urls;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const client = await pool.connect();
  try {
    const { rows: dbRows } = await client.query("SELECT current_database() AS name");
    console.log(`Database: ${dbRows[0].name}${dryRun ? " (dry run, nothing is written)" : ""}`);

    await client.query("BEGIN");

    const vendorNames = [...new Set(searches.map((search) => search.vendorName))];
    const { rows: vendorRows } = await client.query(
      "SELECT vendor_id, name FROM vendor WHERE name = ANY($1::text[])",
      [vendorNames],
    );
    const vendorIds = new Map<string, number>(vendorRows.map((row) => [row.name, Number(row.vendor_id)]));
    const missing = vendorNames.filter((name) => !vendorIds.has(name));
    if (missing.length > 0) {
      throw new Error(`Vendor(s) not found: ${missing.join(", ")}. Check the spelling, or run the vendor migration first.`);
    }

    let { rows: distributorRows } = await client.query(
      "SELECT distributor_id FROM distributor WHERE name = $1",
      [DISTRIBUTOR_NAME],
    );
    let distributorId: number | null = distributorRows.length > 0 ? Number(distributorRows[0].distributor_id) : null;
    if (distributorId === null) {
      if (dryRun) {
        console.log(`Would create distributor "${DISTRIBUTOR_NAME}".`);
      } else {
        ({ rows: distributorRows } = await client.query(
          "INSERT INTO distributor (name) VALUES ($1) RETURNING distributor_id",
          [DISTRIBUTOR_NAME],
        ));
        distributorId = Number(distributorRows[0].distributor_id);
        console.log(`Created distributor "${DISTRIBUTOR_NAME}" (id ${distributorId}).`);
      }
    }

    const summary: Array<{ vendor: string; url: string; result: string }> = [];
    for (const search of searches) {
      const vendorId = vendorIds.get(search.vendorName)!;
      for (const url of pageUrls(search)) {
        if (distributorId === null) {
          summary.push({ vendor: search.vendorName, url, result: "would insert" });
          continue;
        }
        const { rows: existing } = await client.query(
          `SELECT source_id, is_active FROM pricing_source
            WHERE vendor_id = $1 AND distributor_id = $2 AND source_url = $3
            ORDER BY source_id LIMIT 1`,
          [vendorId, distributorId, url],
        );
        if (existing.length > 0) {
          const state = existing[0].is_active ? "active" : "INACTIVE (left as is)";
          summary.push({ vendor: search.vendorName, url, result: `already there (id ${existing[0].source_id}, ${state})` });
          continue;
        }
        if (dryRun) {
          summary.push({ vendor: search.vendorName, url, result: "would insert" });
          continue;
        }
        const { rows: inserted } = await client.query(
          `INSERT INTO pricing_source (vendor_id, distributor_id, source_url, is_active)
           VALUES ($1, $2, $3, TRUE) RETURNING source_id`,
          [vendorId, distributorId, url],
        );
        summary.push({ vendor: search.vendorName, url, result: `inserted (id ${inserted[0].source_id})` });
      }
    }

    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    console.table(summary);

    const newPages = summary.filter((row) => row.result.startsWith("inserted") || row.result === "would insert").length;
    console.log(`${newPages} new page(s): about ${newPages * 5} more Firecrawl credits per weekly run, ${Math.round(newPages * 5 * 4.35)} per month.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
