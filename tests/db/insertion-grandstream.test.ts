jest.mock("../../src/config/database", () => ({
  pool: {
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
  },
}));
import routers from "../../db/catalog/grandstream/grandstream-routers.json";
import switches from "../../db/catalog/grandstream/grandstream-switches.json";
import aps from "../../db/catalog/grandstream/grandstream-aps.json";
import { deviceSchemas } from "../../db/catalog/schema/generated-schema";

const allDevices = [...routers, ...switches, ...aps];

const specBlocks = [
  "gateway_router_specs",
  "switch_specs",
  "ap_specs",
  "firewall_specs",
  "controller_specs",
] as const;

describe("NWP-SETUP-013: Grandstream insertion preflight", () => {
  test("catalog contains exactly 43 devices", () => {
    expect(routers).toHaveLength(7);
    expect(switches).toHaveLength(24);
    expect(aps).toHaveLength(12);
    expect(allDevices).toHaveLength(43);
  });

  test("all devices pass generated schema validation", () => {
    for (const device of allDevices) {
      const result = deviceSchemas.safeParse(device);

      expect(result.success).toBe(true);
    }
  });

  test("validated devices preserve all specification blocks", () => {
    for (const device of allDevices) {
      const result = deviceSchemas.safeParse(device);

      if (!result.success) {
        throw new Error(`Invalid device: ${device.sku}`);
      }

      for (const block of specBlocks) {
        const original = (device as Record<string, unknown>)[block];
        const parsed = (result.data as Record<string, unknown>)[block];

        expect(Boolean(parsed)).toBe(Boolean(original));
      }
    }
  });

  test("catalog contains exactly 58 specification blocks", () => {
    const counts = Object.fromEntries(
      specBlocks.map((block) => [
        block,
        allDevices.filter(
          (device) => Boolean((device as Record<string, unknown>)[block])
        ).length,
      ])
    );

    expect(counts).toEqual({
      gateway_router_specs: 7,
      switch_specs: 28,
      ap_specs: 12,
      firewall_specs: 4,
      controller_specs: 7,
    });

    expect(
      Object.values(counts).reduce((sum, count) => sum + count, 0)
    ).toBe(58);
  });

  test("every device has a unique SKU", () => {
    const skus = allDevices.map((device) => device.sku);

    expect(new Set(skus).size).toBe(43);
  });

  test("integrated gateways retain their additional roles", () => {
    const integratedGateways = routers.filter(
      (device) => "controller_specs" in device
    );

    expect(integratedGateways).toHaveLength(7);

    const gatewaysWithSwitches = routers.filter(
      (device) => "switch_specs" in device
    );

    expect(gatewaysWithSwitches).toHaveLength(4);
  });
});

describe("NWP-SETUP-013: SQL unit tests", () => {
  const createClient = (responses: unknown[]) => {
    const query = jest.fn();

    for (const response of responses) {
      query.mockResolvedValueOnce(response);
    }

    return { query };
  };

  test("resolves Grandstream vendor by name", async () => {
    const { resolveGrandstreamVendorId } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = createClient([
      {
        rowCount: 1,
        rows: [{ vendor_id: 12 }],
      },
    ]);

    const vendorId = await resolveGrandstreamVendorId(client as any);

    expect(vendorId).toBe(12);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM vendor"),
      ["Grandstream GWN Cloud"]
    );
  });

  test("rejects missing Grandstream vendor", async () => {
    const { resolveGrandstreamVendorId } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = createClient([
      {
        rowCount: 0,
        rows: [],
      },
    ]);

    await expect(
      resolveGrandstreamVendorId(client as any)
    ).rejects.toThrow("Grandstream vendor not found");
  });

  test("resolves product line using database vendor ID", async () => {
    const { findProductLineId } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = createClient([
      {
        rowCount: 1,
        rows: [{ product_line_id: 35 }],
      },
    ]);

    const productLineId = await findProductLineId(client as any, {
      vendor_id: 12,
      category: "gateway_router",
      product_line: "GWN7000",
    });

    expect(productLineId).toBe(35);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM product_line"),
      [12, "gateway_router", "GWN7000"]
    );
  });

  test("skips unresolved product lines with a clear error", async () => {
    const { findProductLineId } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = createClient([
      {
        rowCount: 0,
        rows: [],
      },
    ]);

    await expect(
      findProductLineId(client as any, {
        vendor_id: 12,
        category: "gateway_router",
        product_line: "UNKNOWN",
      })
    ).rejects.toThrow("Product line not found");
  });

  test("device upsert preserves existing price on null input", async () => {
    const { upsertDevice } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = createClient([
      {
        rowCount: 1,
        rows: [{ device_id: 77, inserted: false }],
      },
    ]);

    const result = await upsertDevice(
      client as any,
      {
        vendor_id: 12,
        sku: "TEST-GWN",
        price: null,
        price_updated_at: null,
        name: "Test Grandstream Device",
        description: "Test",
        is_rack_mountable: false,
        u_height: 0,
        lifecycle_status: "active",
        eos_date: null,
        eol_date: null,
      },
      35
    );

    expect(result).toEqual({
      deviceId: 77,
      inserted: false,
    });

    const sql = client.query.mock.calls[0][0] as string;
    const params = client.query.mock.calls[0][1] as unknown[];

    expect(sql).toContain(
      "price = COALESCE(EXCLUDED.price, device.price)"
    );

    expect(sql).toContain("ELSE device.price_updated_at");
    expect(sql).toContain("ON CONFLICT (vendor_id, sku)");

    expect(params[0]).toBe(12);
    expect(params[1]).toBe("TEST-GWN");
    expect(params[2]).toBeNull();
    expect(params[11]).toBe(35);
  });
});

describe("NWP-SETUP-013: multi-role and capabilities", () => {
  const makeClient = (handler: (sql: string, params?: unknown[]) => unknown) => ({
    query: jest.fn(async (sql: string, params?: unknown[]) =>
      handler(sql, params)
    ),
  });

  test("GCC gateway writes four specification types under one device ID", async () => {
    const { upsertDeviceWithSpecs } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const gcc = routers.find((device) => device.sku === "GCC6010");

    expect(gcc).toBeDefined();

    const client = makeClient((sql) => {
      if (sql.includes("SELECT device_id")) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("INSERT INTO device (")) {
        return {
          rowCount: 1,
          rows: [{ device_id: 101, inserted: true }],
        };
      }

      if (sql.includes("FROM capability")) {
        return { rowCount: 1, rows: [{ capability_id: 1 }] };
      }

      return { rowCount: 1, rows: [] };
    });

    await upsertDeviceWithSpecs(client as any, gcc, 25);

    const specificationTables = [
      "gateway_router_specifications",
      "switch_specifications",
      "firewall_specifications",
      "controller_specifications",
    ];

    for (const table of specificationTables) {
      const call = client.query.mock.calls.find(
        ([sql]) => sql.includes(`INSERT INTO ${table} (`)
      );

      expect(call).toBeDefined();
      expect(call![1]?.[0]).toBe(101);
    }

    expect(
      client.query.mock.calls.some(
        ([sql]) => sql.includes("INSERT INTO ap_specifications")
      )
    ).toBe(false);
  });

  test("GWN gateway writes gateway and integrated controller specs", async () => {
    const { upsertDeviceWithSpecs } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const gwn = routers.find((device) => device.sku === "GWN7001");

    expect(gwn).toBeDefined();

    const client = makeClient((sql) => {
      if (sql.includes("SELECT device_id")) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("INSERT INTO device (")) {
        return {
          rowCount: 1,
          rows: [{ device_id: 102, inserted: true }],
        };
      }

      if (sql.includes("FROM capability")) {
        return { rowCount: 1, rows: [{ capability_id: 1 }] };
      }

      return { rowCount: 1, rows: [] };
    });

    await upsertDeviceWithSpecs(client as any, gwn, 25);

    const sqlStatements = client.query.mock.calls.map(([sql]) => sql);

    expect(
      sqlStatements.some((sql) =>
        sql.includes("INSERT INTO gateway_router_specifications")
      )
    ).toBe(true);

    expect(
      sqlStatements.some((sql) =>
        sql.includes("INSERT INTO controller_specifications")
      )
    ).toBe(true);

    expect(
      sqlStatements.some((sql) =>
        sql.includes("INSERT INTO firewall_specifications")
      )
    ).toBe(false);
  });

  test("cleanup removes only specification types absent from incoming device", async () => {
    const { cleanupStaleSpecifications } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const gcc = routers.find((device) => device.sku === "GCC6010");

    expect(gcc).toBeDefined();

    const client = makeClient(() => ({
      rowCount: 1,
      rows: [],
    }));

    await cleanupStaleSpecifications(client as any, 101, gcc);

    const deletes = client.query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.startsWith("DELETE FROM"));

    expect(deletes).toEqual([
      "DELETE FROM ap_specifications WHERE device_id = $1",
    ]);
  });

  test("existing capability is reused without inserting a duplicate", async () => {
    const { resolveCapabilityId } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = makeClient(() => ({
      rowCount: 1,
      rows: [{ capability_id: 9 }],
    }));

    const id = await resolveCapabilityId(client as any, "vpn");

    expect(id).toBe(9);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE capability_desc = $1"),
      ["vpn"]
    );
  });

  test("capability synchronization removes obsolete links and upserts current links", async () => {
    const { linkCapabilities } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = makeClient((sql, params) => {
      if (sql.includes("FROM capability")) {
        const capability = params?.[0];
        return {
          rowCount: 1,
          rows: [{ capability_id: capability === "vpn" ? 9 : 10 }],
        };
      }

      return { rowCount: 1, rows: [] };
    });

    await linkCapabilities(client as any, 101, ["vpn", "firewall"]);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM device_capability"),
      [101, [9, 10]]
    );

    const inserts = client.query.mock.calls.filter(
      ([sql]) => sql.includes("INSERT INTO device_capability")
    );

    expect(inserts).toHaveLength(2);
    expect(inserts[0][1]).toEqual([101, 9]);
    expect(inserts[1][1]).toEqual([101, 10]);
  });
});

describe("NWP-SETUP-013: transaction handling", () => {
  const { pool } = jest.requireMock("../../src/config/database") as {
    pool: { connect: jest.Mock };
  };

  const makeClient = (options: {
    existing?: boolean;
    inserted?: boolean;
    failOn?: string;
    productLineFound?: boolean;
  } = {}) => {
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (options.failOn && sql.includes(options.failOn)) {
        throw new Error("Simulated database failure");
      }

      if (sql.includes("FROM vendor")) {
        return {
          rowCount: 1,
          rows: [{ vendor_id: 12 }],
        };
      }

      if (sql.includes("FROM product_line")) {
        return options.productLineFound === false
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ product_line_id: 35 }] };
      }

      if (
        sql.includes("FROM device") &&
        sql.includes("WHERE name = $1")
      ) {
        return options.existing
          ? {
              rowCount: 1,
              rows: [{
                device_id: 77,
                vendor_id: 12,
                sku: routers[0].sku,
              }],
            }
          : { rowCount: 0, rows: [] };
      }

      if (
        sql.includes("SELECT device_id") &&
        sql.includes("FROM device")
      ) {
        return options.existing
          ? { rowCount: 1, rows: [{ device_id: 77 }] }
          : { rowCount: 0, rows: [] };
      }

      if (sql.includes("INSERT INTO device (")) {
        return {
          rowCount: 1,
          rows: [{
            device_id: 77,
            inserted: options.inserted ?? !options.existing,
          }],
        };
      }

      if (sql.includes("FROM capability")) {
        return {
          rowCount: 1,
          rows: [{ capability_id: 9 }],
        };
      }

      return { rowCount: 1, rows: [] };
    });

    return {
      query,
      release: jest.fn(),
    };
  };

  beforeEach(() => {
    pool.connect = jest.fn();
  });

  test("successful insertion commits and releases client", async () => {
    const { seedOneDevice } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = makeClient();
    pool.connect.mockResolvedValue(client);

    const result = await seedOneDevice(routers[0]);

    expect(result).toEqual({
      deviceId: 77,
      inserted: true,
    });

    const sql = client.query.mock.calls.map(([statement]) => statement);

    expect(sql[0]).toBe("BEGIN");
    expect(sql).toContain("COMMIT");
    expect(sql).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("specification failure rolls back and releases client", async () => {
    const { seedOneDevice } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = makeClient({
      failOn: "INSERT INTO gateway_router_specifications",
    });

    pool.connect.mockResolvedValue(client);

    await expect(
      seedOneDevice(routers[0])
    ).rejects.toThrow("Simulated database failure");

    const sql = client.query.mock.calls.map(([statement]) => statement);

    expect(sql[0]).toBe("BEGIN");
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("missing product line rolls back before device insertion", async () => {
    const { seedOneDevice } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = makeClient({
      productLineFound: false,
    });

    pool.connect.mockResolvedValue(client);

    await expect(
      seedOneDevice(routers[0])
    ).rejects.toThrow("Product line not found");

    const sql = client.query.mock.calls.map(([statement]) => statement);

    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");

    expect(
      sql.some((statement) =>
        statement.includes("INSERT INTO device (")
      )
    ).toBe(false);

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("device insertion uses dynamically resolved vendor ID", async () => {
    const { seedOneDevice } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = makeClient();
    pool.connect.mockResolvedValue(client);

    await seedOneDevice({
      ...routers[0],
      vendor_id: 999,
    });

    const deviceCall = client.query.mock.calls.find(
      ([statement]) => statement.includes("INSERT INTO device (")
    );

    expect(deviceCall).toBeDefined();
    expect(deviceCall![1]?.[0]).toBe(12);

    const productLineCall = client.query.mock.calls.find(
      ([statement]) => statement.includes("FROM product_line")
    );

    expect(productLineCall![1]?.[0]).toBe(12);
  });

  test("existing device is updated and committed without creating a new ID", async () => {
    const { seedOneDevice } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = makeClient({
      existing: true,
      inserted: false,
    });

    pool.connect.mockResolvedValue(client);

    const result = await seedOneDevice(routers[0]);

    expect(result).toEqual({
      deviceId: 77,
      inserted: false,
    });

    const sql = client.query.mock.calls.map(([statement]) => statement);

    expect(sql).toContain("COMMIT");
    expect(sql).not.toContain("ROLLBACK");

    const deviceUpserts = sql.filter((statement) =>
      statement.includes("INSERT INTO device (")
    );

    expect(deviceUpserts).toHaveLength(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("NWP-SETUP-013: device name collision protection", () => {
  const { pool } = jest.requireMock("../../src/config/database") as {
    pool: { connect: jest.Mock };
  };

  const makeCollisionClient = (
    ownerVendorId: number,
    ownerSku: string
  ) => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM vendor")) {
        return { rowCount: 1, rows: [{ vendor_id: 12 }] };
      }

      if (sql.includes("FROM product_line")) {
        return { rowCount: 1, rows: [{ product_line_id: 35 }] };
      }

      if (
        sql.includes("FROM device") &&
        sql.includes("WHERE name = $1")
      ) {
        return {
          rowCount: 1,
          rows: [{
            device_id: 77,
            vendor_id: ownerVendorId,
            sku: ownerSku,
          }],
        };
      }

      if (
        sql.includes("SELECT device_id") &&
        sql.includes("FROM device")
      ) {
        return { rowCount: 1, rows: [{ device_id: 77 }] };
      }

      if (sql.includes("INSERT INTO device (")) {
        return {
          rowCount: 1,
          rows: [{ device_id: 77, inserted: false }],
        };
      }

      if (sql.includes("FROM capability")) {
        return {
          rowCount: 1,
          rows: [{ capability_id: 9 }],
        };
      }

      return { rowCount: 1, rows: [] };
    });

    return { query, release: jest.fn() };
  };

  test.each([
    ["another vendor", 99, routers[0].sku],
    ["another SKU", 12, "OTHER-GRANDSTREAM-SKU"],
  ])(
    "rejects name owned by %s before modifying specifications",
    async (_description, vendorId, sku) => {
      const { seedOneDevice } = await import(
        "../../scripts/seed-grandstream-devices"
      );

      const client = makeCollisionClient(vendorId, sku);
      pool.connect = jest.fn().mockResolvedValue(client);

      await expect(
        seedOneDevice(routers[0])
      ).rejects.toThrow("Device name collision:");

      const statements = client.query.mock.calls.map(
        ([sql]) => sql as string
      );

      expect(statements).toContain("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      expect(
        statements.some((sql) =>
          sql.includes("DELETE FROM")
        )
      ).toBe(false);
      expect(
        statements.some((sql) =>
          sql.includes("INSERT INTO device (")
        )
      ).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    }
  );

  test("allows the same vendor and SKU to update", async () => {
    const { seedOneDevice } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const client = makeCollisionClient(12, routers[0].sku);
    pool.connect = jest.fn().mockResolvedValue(client);

    const result = await seedOneDevice(routers[0]);

    expect(result).toEqual({
      deviceId: 77,
      inserted: false,
    });

    const statements = client.query.mock.calls.map(
      ([sql]) => sql as string
    );

    expect(statements).toContain("COMMIT");
    expect(statements).not.toContain("ROLLBACK");
    expect(
      statements.some((sql) =>
        sql.includes("INSERT INTO device (")
      )
    ).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
describe("NWP-SETUP-013: capability creation and failure", () => {
  test("missing capability is inserted with the next available ID", async () => {
    const { resolveCapabilityId } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ next_id: 42 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const id = await resolveCapabilityId({ query } as any, "new-capability");

    expect(id).toBe(42);
    expect(query).toHaveBeenCalledTimes(5);
    expect(query).toHaveBeenNthCalledWith(
      2,
      "LOCK TABLE capability IN EXCLUSIVE MODE"
    );
    expect(query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO capability"),
      [42, "new-capability"]
    );
  });

  test("capability recheck prevents duplicate insertion", async () => {
    const { resolveCapabilityId } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ capability_id: 25 }],
      });

    const id = await resolveCapabilityId({ query } as any, "existing-after-lock");

    expect(id).toBe(25);
    expect(query).toHaveBeenCalledTimes(3);

    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO capability")
      )
    ).toBe(false);
  });

  test("capability insertion failure rolls back the device transaction", async () => {
    const { seedOneDevice } = await import(
      "../../scripts/seed-grandstream-devices"
    );

    const { pool } = jest.requireMock("../../src/config/database") as {
      pool: { connect: jest.Mock };
    };

    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM vendor")) {
        return { rowCount: 1, rows: [{ vendor_id: 12 }] };
      }

      if (sql.includes("FROM product_line")) {
        return { rowCount: 1, rows: [{ product_line_id: 35 }] };
      }

      if (sql.includes("SELECT device_id") && sql.includes("FROM device")) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("INSERT INTO device (")) {
        return {
          rowCount: 1,
          rows: [{ device_id: 77, inserted: true }],
        };
      }

      if (sql.includes("MAX(capability_id)")) {
        return { rowCount: 1, rows: [{ next_id: 42 }] };
      }

      if (sql.includes("FROM capability")) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("INSERT INTO capability")) {
        throw new Error("Simulated capability insertion failure");
      }

      return { rowCount: 1, rows: [] };
    });

    const release = jest.fn();

    pool.connect.mockResolvedValue({ query, release });

    await expect(
      seedOneDevice({
        ...routers[0],
        capabilities: ["new-capability"],
      })
    ).rejects.toThrow("Simulated capability insertion failure");

    const statements = query.mock.calls.map(([sql]) => sql);

    expect(statements).toContain("BEGIN");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
