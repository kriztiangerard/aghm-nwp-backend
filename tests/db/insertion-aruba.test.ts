import { resolveCapabilityId } from "../../scripts/seed-aruba-devices";

describe("NWP-SETUP-009 Aruba capability resolution", () => {
  test("reuses an existing capability ID", async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rowCount: 1,
        rows: [{ capability_id: 2 }],
      }),
    };

    const result = await resolveCapabilityId(client as any, "router");

    expect(result).toBe(2);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE capability_desc = $1"),
      ["router"]
    );
  });

  test("creates a capability when it does not exist", async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: null, rows: [] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rows: [{ next_id: 5 }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    };

    const result = await resolveCapabilityId(client as any, "firewall");

    expect(result).toBe(5);
    expect(client.query).toHaveBeenCalledTimes(5);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO capability"),
      [5, "firewall"]
    );
  });

  test("reuses a capability created by another transaction", async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: null, rows: [] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ capability_id: 3 }],
        }),
    };

    const result = await resolveCapabilityId(client as any, "switch");

    expect(result).toBe(3);
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO capability"),
      expect.anything()
    );
  });
});

describe("NWP-SETUP-009 AC2 subtype insertion", () => {
  const createClient = () => ({
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT device_id")) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("RETURNING device_id")) {
        return {
          rowCount: 1,
          rows: [{ device_id: 101, inserted: true }],
        };
      }

      return { rowCount: 1, rows: [] };
    }),
  });

  const core = {
    vendor_id: 1,
    sku: "TEST-ARUBA-001",
    price: null,
    name: "Test Aruba Device",
    description: "Test device",
    is_rack_mountable: false,
    u_height: 0,
    lifecycle_status: "active",
    eos_date: null,
    eol_date: null,
    capabilities: [],
  };

  test.each([
    [
      "gateway_router",
      "gateway_router_specifications",
      {
        gateway_router_specs: {
          wan_ports: 1,
          lan_ports: 3,
          vpn_supported: true,
        },
      },
    ],
    [
      "switch",
      "switch_specifications",
      {
        switch_specs: {
          port_count: 8,
          layer: 2,
        },
      },
    ],
    [
      "ap",
      "ap_specifications",
      {
        ap_specs: {
          wifi_standard: 6,
          supported_24ghz: true,
          supported_5ghz: true,
          supported_6ghz: false,
        },
      },
    ],
  ])(
    "inserts %s specifications into %s",
    async (category, table, specs) => {
      const { upsertDeviceWithSpecs } =
        require("../../scripts/seed-aruba-devices");

      const client = createClient();
      const device = { ...core, category, ...specs };

      const result = await upsertDeviceWithSpecs(
        client as any,
        device,
        1
      );

      expect(result.deviceId).toBe(101);

      const queries = client.query.mock.calls.map(
        ([sql]: [string]) => sql
      );

      expect(
        queries.some((sql: string) =>
          sql.includes(`INSERT INTO ${table}`)
        )
      ).toBe(true);
    }
  );

  test("gateway with firewall inserts both specification rows", async () => {
    const { upsertDeviceWithSpecs } =
      require("../../scripts/seed-aruba-devices");

    const client = createClient();

    const device = {
      ...core,
      category: "gateway_router",
      gateway_router_specs: {
        wan_ports: 1,
        lan_ports: 3,
        vpn_supported: true,
      },
      firewall_specs: {
        firewall_throughputs_mbps: 980,
        vpn_throughput_mbps: 930,
        max_concurrent_sessions: 16384,
      },
    };

    await upsertDeviceWithSpecs(client as any, device, 1);

    const queries = client.query.mock.calls.map(
      ([sql]: [string]) => sql
    );

    expect(
      queries.some((sql: string) =>
        sql.includes("INSERT INTO gateway_router_specifications")
      )
    ).toBe(true);

    expect(
      queries.some((sql: string) =>
        sql.includes("INSERT INTO firewall_specifications")
      )
    ).toBe(true);
  });
});

describe("NWP-SETUP-009 AC5 SKU-based updates", () => {
  test("updates an existing device using the same device_id", async () => {
    const { upsertDeviceWithSpecs } =
      require("../../scripts/seed-aruba-devices");

    const queries: string[] = [];

    const client = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        queries.push(sql);

        if (sql.includes("SELECT device_id")) {
          return {
            rowCount: 1,
            rows: [{ device_id: 101 }],
          };
        }

        if (sql.includes("RETURNING device_id")) {
          return {
            rowCount: 1,
            rows: [{ device_id: 101, inserted: false }],
          };
        }

        return { rowCount: 1, rows: [] };
      }),
    };

    const device = {
      vendor_id: 1,
      sku: "TEST-ARUBA-001",
      price: 500,
      name: "Updated Aruba Switch",
      description: "Updated device",
      is_rack_mountable: false,
      u_height: 0,
      lifecycle_status: "active",
      eos_date: null,
      eol_date: null,
      category: "switch",
      capabilities: [],
      switch_specs: {
        port_count: 24,
        layer: 2,
      },
    };

    const result = await upsertDeviceWithSpecs(
      client as any,
      device,
      1
    );

    expect(result).toEqual({
      deviceId: 101,
      inserted: false,
    });

    expect(
      queries.some((sql) =>
        sql.includes("ON CONFLICT (vendor_id, sku)")
      )
    ).toBe(true);

    expect(
      queries.some((sql) =>
        sql.includes("ON CONFLICT (device_id)")
      )
    ).toBe(true);
  });
});

describe("NWP-SETUP-009 AC4 transaction rollback", () => {
  test("rolls back when device insertion fails", async () => {
    const { seedOneDevice } =
      require("../../scripts/seed-aruba-devices");

    const { pool } = require("../../src/config/database");

    const queries: string[] = [];

    const client = {
      query: jest.fn().mockImplementation(async (
        sql: string
      ) => {
        queries.push(sql);

        if (sql.includes("FROM product_line")) {
          throw new Error("Product line not found");
        }

        return { rowCount: 1, rows: [] };
      }),
      release: jest.fn(),
    };

    const connectSpy = jest
      .spyOn(pool, "connect")
      .mockResolvedValue(client as any);

    const device = {
      vendor_id: 1,
      sku: "TEST-ROLLBACK",
      category: "switch",
      product_line: "1430",
    };

    try {
      await expect(seedOneDevice(device)).rejects.toThrow(
        "Product line not found"
      );

      expect(queries).toContain("BEGIN");
      expect(queries).toContain("ROLLBACK");
      expect(queries).not.toContain("COMMIT");
      expect(client.release).toHaveBeenCalledTimes(1);
    } finally {
      connectSpy.mockRestore();
    }
  });
});

describe("NWP-SETUP-009 AC6 ingestion summary", () => {
  const { printIngestionSummary } =
    require("../../scripts/seed-aruba-devices");

  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("reports inserted, updated, skipped, and total counts", () => {
    printIngestionSummary(26, 20, 4, 2);

    const output = logSpy.mock.calls
      .map((call) => String(call[0]))
      .join("\n");

    expect(output).toContain("ARUBA INGESTION SUMMARY");
    expect(output).toContain("Total devices: 26");
    expect(output).toContain("Inserted: 20");
    expect(output).toContain("Updated: 4");
    expect(output).toContain("Skipped: 2");
  });

  test("reports zero counts explicitly", () => {
    printIngestionSummary(0, 0, 0, 0);

    const output = logSpy.mock.calls
      .map((call) => String(call[0]))
      .join("\n");

    expect(output).toContain("Total devices: 0");
    expect(output).toContain("Inserted: 0");
    expect(output).toContain("Updated: 0");
    expect(output).toContain("Skipped: 0");
  });
});
