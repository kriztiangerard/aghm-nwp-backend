jest.mock("pg", () => ({
  Client: jest.fn(),
}));
import productLines from "../../db/catalog/grandstream/grandstream-productlines.json";
import { Client } from "pg";
import { main, validateProductLines } from "../../scripts/insert-grandstream-productlines";

type ProductLine = (typeof productLines)[number];

const cloneLines = (): ProductLine[] =>
  JSON.parse(JSON.stringify(productLines)) as ProductLine[];

describe("NWP-SETUP-013: Grandstream product-line validation", () => {
  test("accepts the complete 16-line catalog", () => {
    expect(productLines).toHaveLength(16);
    expect(() => validateProductLines(cloneLines())).not.toThrow();
  });

  test("rejects an unsupported category", () => {
    const lines = cloneLines();
    lines[0].category = "unsupported";

    expect(() => validateProductLines(lines)).toThrow(
      "Invalid product line"
    );
  });

  test("rejects duplicate product-line names within a category", () => {
    const lines = cloneLines();

    const first = lines[0];
    const second = lines.find(
      (line, index) =>
        index !== 0 && line.category === first.category
    );

    expect(second).toBeDefined();
    second!.name = first.name;

    expect(() => validateProductLines(lines)).toThrow(
      "Duplicate product line or rank"
    );
  });

  test("rejects duplicate ranks within a category", () => {
    const lines = cloneLines();

    const first = lines[0];
    const second = lines.find(
      (line, index) =>
        index !== 0 && line.category === first.category
    );

    expect(second).toBeDefined();
    second!.line_rank = first.line_rank;

    expect(() => validateProductLines(lines)).toThrow(
      "Duplicate product line or rank"
    );
  });

  test("rejects malformed product-line metadata", () => {
    const lines = cloneLines();
    lines[0].source_note = "";

    expect(() => validateProductLines(lines)).toThrow(
      "Invalid product line"
    );
  });
});
describe("NWP-SETUP-013: Grandstream product-line SQL transactions", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    jest.clearAllMocks();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  function mockClient(options: {
    existing?: boolean;
    failInsert?: boolean;
  } = {}) {
    const queries: string[] = [];

    const query = jest.fn(async (sql: string) => {
      queries.push(sql);

      if (sql.includes("INSERT INTO vendor")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("SELECT vendor_id FROM vendor")) {
        return { rowCount: 1, rows: [{ vendor_id: 77 }] };
      }

      if (sql.includes("SELECT product_line_id")) {
        return {
          rowCount: options.existing ? 1 : 0,
          rows: options.existing ? [{ product_line_id: 10 }] : [],
        };
      }

      if (sql.includes("INSERT INTO product_line")) {
        if (options.failInsert) {
          throw new Error("Simulated product-line insertion failure");
        }

        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    });

    const connect = jest.fn(async () => undefined);
    const end = jest.fn(async () => undefined);

    (Client as jest.Mock).mockImplementation(() => ({
      connect,
      query,
      end,
    }));

    process.env.DATABASE_URL = "postgresql://mock:mock@localhost/mock";

    return { queries, query, connect, end };
  }

  test("preserves existing vendor configuration on conflict", async () => {
    const mock = mockClient({ existing: true });

    await main();

    const vendorInsert = mock.query.mock.calls.find(
      (call) => String(call[0]).includes("INSERT INTO vendor")
    );

    expect(vendorInsert).toBeDefined();
    expect(vendorInsert![0]).toContain("ON CONFLICT (name) DO NOTHING");
    expect(vendorInsert![0]).not.toContain("DO UPDATE SET");

    expect(mock.queries).toContain("COMMIT");
  });

  test("initializes new vendor and retrieves its database ID", async () => {
    const mock = mockClient();

    await main();

    const vendorInsert = mock.query.mock.calls.find(
      (call) => String(call[0]).includes("INSERT INTO vendor")
    );

    expect(vendorInsert).toBeDefined();
    expect(vendorInsert![0]).toContain("VALUES ($1, FALSE, ARRAY['dashboard']::TEXT[])");

    const lookup = mock.query.mock.calls.find(
      (call) => String(call[0]).includes("SELECT vendor_id FROM vendor")
    );

    expect(lookup).toBeDefined();
    expect(lookup![1]).toEqual(["Grandstream GWN Cloud"]);

    const insertIndex = mock.queries.findIndex(
      (sql) => sql.includes("INSERT INTO vendor")
    );

    const lookupIndex = mock.queries.findIndex(
      (sql) => sql.includes("SELECT vendor_id FROM vendor")
    );

    expect(insertIndex).toBeLessThan(lookupIndex);
    expect(mock.queries).toContain("COMMIT");
  });
  test("begins transaction and defers product-line rank constraint", async () => {
    const mock = mockClient();

    await main();

    expect(mock.connect).toHaveBeenCalledTimes(1);
    expect(mock.queries).toContain("BEGIN");
    expect(mock.queries).toContain(
      "SET CONSTRAINTS product_line_rank_unique DEFERRED"
    );
    expect(mock.queries).toContain("COMMIT");

    expect(mock.queries.indexOf("BEGIN")).toBeLessThan(
      mock.queries.indexOf(
        "SET CONSTRAINTS product_line_rank_unique DEFERRED"
      )
    );

    expect(mock.end).toHaveBeenCalledTimes(1);
  });

  test("uses the database-assigned vendor ID for every product line", async () => {
    const mock = mockClient();

    await main();

    const inserts = mock.query.mock.calls.filter(
      (call) => String(call[0]).includes("INSERT INTO product_line")
    );

    expect(inserts).toHaveLength(16);

    for (const call of inserts) {
      expect(call[1][0]).toBe(77);
    }
  });

  test("inserts all 16 product lines and commits", async () => {
    const mock = mockClient();

    await main();

    expect(
      mock.queries.filter((sql) =>
        sql.includes("INSERT INTO product_line")
      )
    ).toHaveLength(16);

    expect(mock.queries).toContain("COMMIT");
    expect(mock.queries).not.toContain("ROLLBACK");
  });

  test("updates existing product lines without duplicating them", async () => {
    const mock = mockClient({ existing: true });

    await main();

    const inserts = mock.query.mock.calls.filter(
      (call) => String(call[0]).includes("INSERT INTO product_line")
    );

    expect(inserts).toHaveLength(16);

    for (const call of inserts) {
      expect(call[0]).toContain(
        "ON CONFLICT (vendor_id, category, name)"
      );
      expect(call[0]).toContain(
        "line_rank = EXCLUDED.line_rank"
      );
    }

    expect(mock.queries).toContain("COMMIT");
  });

  test("rolls back and closes connection when insertion fails", async () => {
    const mock = mockClient({ failInsert: true });

    await expect(main()).rejects.toThrow(
      "Simulated product-line insertion failure"
    );

    expect(mock.queries).toContain("ROLLBACK");
    expect(mock.queries).not.toContain("COMMIT");
    expect(mock.end).toHaveBeenCalledTimes(1);
  });
});