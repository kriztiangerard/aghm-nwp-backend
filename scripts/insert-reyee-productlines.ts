import "dotenv/config";
import { pool } from "../src/config/database";
import productLines from "../db/catalog/reyee/reyee-productlines.json";

const VENDOR_ID = 4;
const VENDOR_NAME = "Ruijie";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (productLines.length !== 8) {
    throw new Error(
      `Expected 8 Reyee product lines, found ${productLines.length}`
    );
  }

  const validCategories = new Set([
    "gateway_router",
    "switch",
    "ap",
  ]);

  const uniqueLines = new Set<string>();
  const uniqueRanks = new Set<string>();

  for (const line of productLines) {
    if (
      line.vendor_id !== VENDOR_ID ||
      !validCategories.has(line.category) ||
      !line.name?.trim() ||
      !Number.isInteger(line.line_rank) ||
      line.line_rank < 1 ||
      !line.source_note?.trim()
    ) {
      throw new Error(`Invalid product line: ${line.name}`);
    }

    const key = `${line.category}:${line.name}`;
    const rankKey = `${line.category}:${line.line_rank}`;

    if (uniqueLines.has(key) || uniqueRanks.has(rankKey)) {
      throw new Error(`Duplicate Reyee product line or rank: ${key}`);
    }

    uniqueLines.add(key);
    uniqueRanks.add(rankKey);
  }

  const client = await pool.connect();

  let inserted = 0;
  let existing = 0;

  try {
    await client.query("BEGIN");

    const vendor = await client.query(
      `SELECT vendor_id, name, need_controller
       FROM vendor
       WHERE vendor_id = $1`,
      [VENDOR_ID]
    );

    if (
      vendor.rowCount !== 1 ||
      vendor.rows[0].name !== VENDOR_NAME
    ) {
      throw new Error(
        `Expected vendor ${VENDOR_ID} to be ${VENDOR_NAME}`
      );
    }

    console.log("Verified vendor:", vendor.rows[0]);

    for (const line of productLines) {
      const result = await client.query(
        `INSERT INTO product_line (
          vendor_id,
          category,
          name,
          line_rank,
          source_note
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (vendor_id, category, name)
        DO NOTHING
        RETURNING product_line_id`,
        [
          line.vendor_id,
          line.category,
          line.name,
          line.line_rank,
          line.source_note,
        ]
      );

      if (result.rowCount && result.rowCount > 0) {
        inserted++;
        console.log(`INSERTED: ${line.category} / ${line.name}`);
      } else {
        existing++;
        console.log(`EXISTS: ${line.category} / ${line.name}`);
      }
    }

    await client.query("COMMIT");

    console.log("\n========== REYEE PRODUCT-LINE SUMMARY ==========");
    console.log(`Total records: ${productLines.length}`);
    console.log(`Inserted: ${inserted}`);
    console.log(`Already existing: ${existing}`);
    console.log("================================================");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(
    "Reyee product-line insertion failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
