import "dotenv/config";
import { Client } from "pg";
import productLines from "../db/catalog/grandstream/grandstream-productlines.json";

const VENDOR_NAME = "Grandstream GWN Cloud";
const EXPECTED_LINES = 16;

type ProductLine = {
  vendor_id: number;
  category: string;
  name: string;
  line_rank: number;
  source_note: string;
};

function validateProductLines(lines: ProductLine[]): void {
  if (!Array.isArray(lines) || lines.length !== EXPECTED_LINES) {
    throw new Error(
      `Expected ${EXPECTED_LINES} Grandstream product lines`
    );
  }

  const names = new Set<string>();
  const ranks = new Set<string>();

  for (const line of lines) {
    if (
      !["gateway_router", "switch", "ap"].includes(line.category) ||
      typeof line.name !== "string" ||
      !line.name.trim() ||
      !Number.isInteger(line.line_rank) ||
      line.line_rank < 1 ||
      typeof line.source_note !== "string" ||
      !line.source_note.trim()
    ) {
      throw new Error(`Invalid product line: ${JSON.stringify(line)}`);
    }

    const nameKey = `${line.category}:${line.name}`;
    const rankKey = `${line.category}:${line.line_rank}`;

    if (names.has(nameKey) || ranks.has(rankKey)) {
      throw new Error(`Duplicate product line or rank: ${nameKey}`);
    }

    names.add(nameKey);
    ranks.add(rankKey);
  }
}

async function main(): Promise<void> {
  validateProductLines(productLines as ProductLine[]);

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DB_SSL === "true"
        ? {
            ca: require("fs").readFileSync("global-bundle.pem").toString(),
            rejectUnauthorized: true,
          }
        : false,
  });

  let transactionStarted = false;
  let inserted = 0;
  let updated = 0;

  try {
    await client.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    // Allow product lines to exchange ranks within this transaction.
    // PostgreSQL verifies rank uniqueness when the transaction commits.
    await client.query(
      "SET CONSTRAINTS product_line_rank_unique DEFERRED"
    );

    const vendorResult = await client.query(
      `INSERT INTO vendor (name, need_controller, management_modes)
       VALUES ($1, FALSE, ARRAY['dashboard']::TEXT[])
       ON CONFLICT (name)
       DO UPDATE SET
         need_controller = FALSE,
         management_modes = ARRAY['dashboard']::TEXT[]
       RETURNING vendor_id`,
      [VENDOR_NAME]
    );

    const vendorId = Number(vendorResult.rows[0].vendor_id);

    console.log(`Grandstream vendor ID: ${vendorId}`);

    for (const line of productLines) {
      const existing = await client.query(
        `SELECT product_line_id
         FROM product_line
         WHERE vendor_id = $1 AND category = $2 AND name = $3`,
        [vendorId, line.category, line.name]
      );

      await client.query(
        `INSERT INTO product_line
           (vendor_id, category, name, line_rank, source_note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vendor_id, category, name)
         DO UPDATE SET
           line_rank = EXCLUDED.line_rank,
           source_note = EXCLUDED.source_note`,
        [
          vendorId,
          line.category,
          line.name,
          line.line_rank,
          line.source_note,
        ]
      );

      if (existing.rowCount === 0) {
        inserted++;
      } else {
        updated++;
      }
    }

    await client.query("COMMIT");
    transactionStarted = false;

    console.log("\n========== GRANDSTREAM PRODUCT LINES ==========");
    console.log(`Vendor: ${VENDOR_NAME}`);
    console.log(`Vendor ID: ${vendorId}`);
    console.log(`Total: ${productLines.length}`);
    console.log(`Inserted: ${inserted}`);
    console.log(`Updated: ${updated}`);
    console.log("===============================================");
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    await client.end();
  }
}

export { validateProductLines, main };

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "Grandstream product-line insertion failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  });
}
