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
// Shoppable shows 25 results per page and pages with an offset: page 1 is the plain search URL, then
// &skip=25, &skip=50, ... (checked in a browser by G, 2026-11-27). Set `results` to the total the search
// reports; the script registers ceil(results / 25) pages. Each page costs 5 Firecrawl credits per weekly run.
// When a total grows past a multiple of 25, raise `results` and run the script again: it adds only the
// new pages. Two searches of the same vendor may list the same product; the updater stores it once when
// the prices agree, and rejects it for that run when they differ (collect.js, combinePages).
//
// A product page can be a source too (`productUrl`), for a model that no search finds cheaply. It is one
// page with one product; the extractor reads the model from the page's MPN/model field. Retired URLs
// (`retiredUrls`) are switched to inactive, not deleted, so their pricing history stays.

import { pool } from "../src/db/client";

const DISTRIBUTOR_NAME = "Shoppable Business";
const SEARCH_URL = "https://business.shoppable.ph/search";
const PAGE_SIZE = 25;
const OFFSET_PARAM = "skip";

type ShoppableSearch =
  | {
      vendorName: string; // must match vendor.name exactly
      query: string;      // the search text, as in ?q=, exactly as typed when counting
      results: number;    // total results the search reports (counted 2026-11-27)
    }
  | {
      vendorName: string;
      productUrl: string; // a single product page
    };

const searches: ShoppableSearch[] = [
  { vendorName: "TP-Link Omada", query: "Omada", results: 27 },
  // Ruijie: "Reyee" returned 227 results (10 pages) for a 10-device catalog, so it is searched by family
  // and model instead. RG-ES228GS-LP is not on Shoppable (2026-11-27).
  { vendorName: "Ruijie", query: "RAP", results: 29 },     // RG-RAP2266, RG-RAP72, RG-RAP73HD
  { vendorName: "Ruijie", query: "EG", results: 16 },      // RG-EG105G-V3, RG-EG105G-P-V3, RG-EG305GH-P-E, RG-EG710XS
  { vendorName: "Ruijie", query: "NBS5200", results: 6 },  // RG-NBS5200-24GT4XS-P-V2
  {                                                        // RG-ES216GC-V2 (MPN on the page)
    vendorName: "Ruijie",
    productUrl: "https://business.shoppable.ph/reyee-b.778/reyee-16-port-gigabit-smart-cloud-managed-switch-or-rack-mount-p.77475",
  },
  { vendorName: "Ubiquiti UniFi", query: "Ubiquiti", results: 21 },
  // "GWN" includes 2 non-Grandstream products (counted as unmatched); "Grandstream" lists some products
  // "GWN" does not, so both are kept.
  { vendorName: "Grandstream GWN Cloud", query: "GWN", results: 21 },
  { vendorName: "Grandstream GWN Cloud", query: "Grandstream", results: 20 },
  // "HPE" also returns servers and storage; they are only counted as unmatched, but every page costs credits.
  // Total not counted yet: one page until it is.
  { vendorName: "HPE Aruba Instant On", query: "HPE", results: 1 },
  // More searches go here, for example:
  // { vendorName: "Cisco Business", query: "Cisco", results: 0 },
];

// Pages registered by earlier versions of this script that are no longer wanted.
const retiredUrls: string[] = [
  `${SEARCH_URL}?q=Reyee`, // replaced by the Ruijie family and model searches above
];

function pageUrls(search: ShoppableSearch): string[] {
  if ("productUrl" in search) {
    if (!search.productUrl.startsWith("https://business.shoppable.ph/")) {
      throw new Error(`productUrl must be a business.shoppable.ph page (${search.vendorName}).`);
    }
    return [search.productUrl];
  }
  if (!Number.isInteger(search.results) || search.results < 1) {
    throw new Error(`results must be a positive integer (${search.vendorName}, "${search.query}").`);
  }
  const first = `${SEARCH_URL}?q=${encodeURIComponent(search.query)}`;
  const urls = [first];
  for (let skip = PAGE_SIZE; skip < search.results; skip += PAGE_SIZE) urls.push(`${first}&${OFFSET_PARAM}=${skip}`);
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

    let retired = 0;
    if (distributorId !== null) {
      for (const url of retiredUrls) {
        const { rows: active } = await client.query(
          `SELECT source_id FROM pricing_source
            WHERE distributor_id = $1 AND source_url = $2 AND is_active
            ORDER BY source_id`,
          [distributorId, url],
        );
        for (const row of active) {
          if (!dryRun) {
            await client.query("UPDATE pricing_source SET is_active = FALSE WHERE source_id = $1", [row.source_id]);
          }
          summary.push({ vendor: "(retired)", url, result: `${dryRun ? "would deactivate" : "deactivated"} (id ${row.source_id})` });
          retired += 1;
        }
      }
    }

    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    console.table(summary);

    const newPages = summary.filter((row) => row.result.startsWith("inserted") || row.result === "would insert").length;
    const change = newPages - retired;
    console.log(`${newPages} new page(s), ${retired} retired: ${change >= 0 ? "about" : "saves about"} ${Math.abs(change) * 5} Firecrawl credits per weekly run, ${Math.round(Math.abs(change) * 5 * 4.35)} per month.`);
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
