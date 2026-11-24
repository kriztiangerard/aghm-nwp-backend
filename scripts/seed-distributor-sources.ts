import { pool } from "../src/db/client";

type DistributorSource = {
  vendorName: string;
  distributorName: string;
  sourceUrl: string;
};

const sources: DistributorSource[] = [
  // HPE Aruba Instant On
  // 2026-11-20 (checked by G): only InfoBahn lists Instant On with prices. MEC Networks and CT Link show
  // no prices, so their rows were removed here and are turned off by deactivate-replaced-sources.sql.
  // The team is requesting a quote from MEC; it goes in as a manual price (npm run pricing:set-manual).
  {
    vendorName: "HPE Aruba Instant On",
    distributorName: "InfoBahn",
    sourceUrl: "https://shop.ibahn.net.ph/collections/aruba-by-hpe-network-switches/network-switches",
  },
  // Added 2026-11-20. Verified: InfoBahn's Instant On access point collection lists AP22/AP25 with
  // peso prices (some items show ₱0.00 placeholders, which the normalizer rejects as zero).
  {
    vendorName: "HPE Aruba Instant On",
    distributorName: "InfoBahn",
    sourceUrl: "https://shop.ibahn.net.ph/collections/aruba-instant-on-wifi-access-point",
  },

  // TP-Link Omada
  // NorthCircuit home page replaced (2026-11-19): Villman lists TP-Link by category with prices.
  {
    vendorName: "TP-Link Omada",
    distributorName: "Villman Computers",
    sourceUrl: "https://villman.com/Category-Brand/Network-Switches/TP-Link",
  },
  {
    vendorName: "TP-Link Omada",
    distributorName: "Villman Computers",
    sourceUrl: "https://villman.com/Category-Brand/Access-Points/TP-Link",
  },
  {
    vendorName: "TP-Link Omada",
    distributorName: "Villman Computers",
    sourceUrl: "https://villman.com/Category-Brand/Broadband-Routers/TP-Link",
  },
  // 2026-11-20: PC Express's Omada-only collection (verified, peso prices) replaces its general
  // TP-Link vendor page, which mixes in Deco, Tapo and other consumer lines across many pages.
  {
    vendorName: "TP-Link Omada",
    distributorName: "PC Express",
    sourceUrl: "https://pcx.com.ph/collections/active/omada",
  },
  // Added 2026-11-20. Verified: Wired Systems (Cebu) lists 32 Omada products with peso prices
  // (EAP, ER605, SG2xxx/SG3xxx). The page shows 20 at a time with "Show more".
  {
    vendorName: "TP-Link Omada",
    distributorName: "Wired Systems",
    sourceUrl: "https://wiredsystems.com/collections/tp-link-omada",
  },
  // Kept on purpose (2026-11-19) as the demonstration source: marketplace store pages are heavily
  // bot-protected, so this scrape is expected to fail every week. It shows (a) Firecrawl failing on a
  // protected site without any CAPTCHA bypass, and (b) Omada prices still coming from the sources above.
  // It never stores a price, so it never marks a device stale or counts toward manual review; its
  // failures appear in the per-page sync log (NWP-PRICE-004). It does spend Firecrawl credits each run.
  {
    vendorName: "TP-Link Omada",
    distributorName: "TP-Link Official Store (Shopee)",
    sourceUrl: "https://shopee.ph/tplink.philippines",
  },
  // Further candidate if one of the above stops working: DynaQuest PC (dynaquestpc.com) lists Omada with
  // peso prices, but no Omada-only listing page was found.

  // Ubiquiti UniFi
  // NorthCircuit home page replaced (2026-11-19): PC Express lists Ubiquiti with prices.
  {
    vendorName: "Ubiquiti UniFi",
    distributorName: "PC Express",
    sourceUrl: "https://pcx.com.ph/collections/vendors?q=Ubiquiti",
  },
  {
    vendorName: "Ubiquiti UniFi",
    distributorName: "MEC Networks",
    sourceUrl: "https://mec.ph/products/wireless/ubiquiti/",
  },
  // Ubiquiti Official Store (LazMall) removed (2026-11-19): marketplace store pages are heavily bot-protected.
  // Added 2026-11-20. InfoBahn's Ubiquiti collection (checked by G).
  {
    vendorName: "Ubiquiti UniFi",
    distributorName: "InfoBahn",
    sourceUrl: "https://shop.ibahn.net.ph/collections/ubiquiti",
  },
  // Added 2026-11-20. Wired Systems sells UniFi with peso prices (U6 Pro at ₱12,990 on its product page).
  // UNVERIFIED listing: Shopify vendor page; if it lists no products, change q= to the vendor name shown
  // on a product page (e.g. "Ubiquiti Networks").
  {
    vendorName: "Ubiquiti UniFi",
    distributorName: "Wired Systems",
    sourceUrl: "https://wiredsystems.com/collections/vendors?q=Ubiquiti",
  },

  // Ruijie
  {
    vendorName: "Ruijie",
    distributorName: "I-Connect Systems Integration, Inc.",
    sourceUrl: "https://www.iconnectph.com/_ruijie.html",
  },
  // Technosure PH home page replaced (2026-11-19): DataBlitz lists Reyee with prices. The collection is
  // shared with ASUS routers, so it is filtered to the Reyee brand (2026-11-20, checked by G).
  // Ronisys removed 2026-11-20: the site is down.
  {
    vendorName: "Ruijie",
    distributorName: "DataBlitz",
    sourceUrl: "https://ecommerce.datablitz.com.ph/collections/reyee-by-ruijie-asus-router?pf_v_brand=Reyee",
  },
  // Added 2026-11-20 (both checked by G). Makotek has no Reyee collection page (the vendor page is a 404),
  // so its store search for "reyee" is used. CCTV Pinoy's Ruijie category shows products with prices.
  // Not added: Bermor Techzone's Ruijie brand page lists products without any prices.
  {
    vendorName: "Ruijie",
    distributorName: "Makotek Computer Sales Inc.",
    sourceUrl: "https://www.makotekcomputers.com/search?type=product&q=reyee&options%5Bunavailable_products%5D=last&options%5Bprefix%5D=last&options%5Bfields%5D=title%2Cvendor%2Cproduct_type%2Cvariants.title",
  },
  {
    vendorName: "Ruijie",
    distributorName: "CCTV Pinoy",
    sourceUrl: "https://www.cctvpinoy.com/product-category/ruijie/",
  },

  // Grandstream GWN Cloud: MANUAL PRICING (decision 2026-11-20). No Philippine store lists Grandstream
  // GWN with peso prices; the only peso listings are import sellers (Newegg PH, Ubuy), which were ruled
  // out. Its former rows (IMV, iConnect, Ardent Networks) are turned off by deactivate-replaced-sources.sql,
  // so the weekly sync spends no credits on it. Prices are entered with npm run pricing:set-manual.

  // Cisco Business
  {
    vendorName: "Cisco Business",
    distributorName: "InfoBahn",
    sourceUrl: "https://shop.ibahn.net.ph/collections/cisco-switches",
  },
  // IMV home page replaced (2026-11-19): PC Express lists Cisco Business with prices.
  {
    vendorName: "Cisco Business",
    distributorName: "PC Express",
    sourceUrl: "https://pcx.com.ph/collections/active/cisco-business",
  },
  {
    vendorName: "Cisco Business",
    distributorName: "Kital Philippines",
    sourceUrl: "https://www.kital.com.ph/cisco/switches-routers-wifi/",
  },
  // Added 2026-11-20. Verified: XBS Asia lists 39 Cisco switches with peso prices (CBS350 and the
  // Catalyst 1200/1300 that replace it), 12 per page; PCWorx lists 4 Cisco items including the CBS350-24T-4X.
  {
    vendorName: "Cisco Business",
    distributorName: "XBS Asia I.T. Solutions",
    sourceUrl: "https://www.xbsasia.ph/product-tag/cisco/",
  },
  {
    vendorName: "Cisco Business",
    distributorName: "PCWorx",
    sourceUrl: "https://pcworx.ph/collections/cisco",
  },
];

// Vendors priced manually, with no scraped sources (decision 2026-11-20). The loop below only creates
// vendors that have a source, so these are created here; manual prices need the vendor row to exist.
const manualOnlyVendors: string[] = ["Grandstream GWN Cloud"];

async function seed() {
  try {
    await pool.query("BEGIN");

    const vendorIds = new Map<string, number>();
    const distributorIds = new Map<string, number>();

    for (const vendorName of manualOnlyVendors) {
      await pool.query(
        `INSERT INTO vendor (name, need_controller)
         SELECT $1, FALSE
         WHERE NOT EXISTS (SELECT 1 FROM vendor WHERE name = $1)`,
        [vendorName]
      );
    }

    for (const source of sources) {
      let vendorResult = await pool.query(
        `SELECT vendor_id
         FROM vendor
         WHERE name = $1`,
        [source.vendorName]
      );

      if (vendorResult.rowCount === 0) {
        vendorResult = await pool.query(
          `INSERT INTO vendor (name, need_controller)
           VALUES ($1, FALSE)
           RETURNING vendor_id`,
          [source.vendorName]
        );
      }

      vendorIds.set(
        source.vendorName,
        vendorResult.rows[0].vendor_id
      );

      let distributorResult = await pool.query(
        `SELECT distributor_id
         FROM distributor
         WHERE name = $1`,
        [source.distributorName]
      );

      if (distributorResult.rowCount === 0) {
        distributorResult = await pool.query(
          `INSERT INTO distributor (name)
           VALUES ($1)
           RETURNING distributor_id`,
          [source.distributorName]
        );
      }

      distributorIds.set(
        source.distributorName,
        distributorResult.rows[0].distributor_id
      );
    }

    for (const source of sources) {
      const vendorId = vendorIds.get(source.vendorName);
      const distributorId = distributorIds.get(source.distributorName);

      if (!vendorId || !distributorId) {
        throw new Error(
          `Missing vendor/distributor ID for ${source.vendorName} / ${source.distributorName}`
        );
      }

      await pool.query(
        `INSERT INTO pricing_source
          (vendor_id, distributor_id, source_url, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [vendorId, distributorId, source.sourceUrl]
      );
    }

    await pool.query("COMMIT");

    const result = await pool.query(
      `SELECT
         ps.source_id,
         v.name AS vendor,
         d.name AS distributor,
         ps.source_url,
         ps.is_active
       FROM pricing_source ps
       JOIN vendor v
         ON v.vendor_id = ps.vendor_id
       JOIN distributor d
         ON d.distributor_id = ps.distributor_id
       ORDER BY v.name, d.name`
    );

    console.log("Distributor sources seeded successfully.");
    console.table(result.rows);
  } catch (error) {
    try {
      await pool.query("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }

    console.error("Seeding failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();
