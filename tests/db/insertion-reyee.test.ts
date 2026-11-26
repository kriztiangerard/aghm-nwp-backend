import { deviceSchemas } from "../../db/catalog/schema/generated-schema";

import routers from "../../db/catalog/reyee/reyee-routers.json";
import switches from "../../db/catalog/reyee/reyee-switches.json";
import aps from "../../db/catalog/reyee/reyee-aps.json";

import { validateDevices } from "../../scripts/seed-reyee-devices";

describe("NWP-SETUP-011 — Reyee Hardware Insertion", () => {
  describe("AC6 — Device validation", () => {
    test("all 10 Reyee catalog devices pass schema validation", () => {
      const devices = [...routers, ...switches, ...aps];

      expect(devices).toHaveLength(10);

      for (const device of devices) {
        const result = deviceSchemas.safeParse(device);

        expect(result.success).toBe(true);
      }
    });

    test("rejects missing required core fields", () => {
      const invalidDevice = {
        ...routers[0],
        sku: undefined,
      };

      const result = deviceSchemas.safeParse(invalidDevice);

      expect(result.success).toBe(false);
    });

    test("rejects invalid device categories", () => {
      const invalidDevice = {
        ...routers[0],
        category: "invalid_category",
      };

      const result = deviceSchemas.safeParse(invalidDevice);

      expect(result.success).toBe(false);
    });

    test("rejects invalid capability strings", () => {
      const invalidDevice = {
        ...routers[0],
        capabilities: ["router", "invalid_capability"],
      };

      const result = deviceSchemas.safeParse(invalidDevice);

      expect(result.success).toBe(false);
    });

    test("rejects an unexpected vendor ID during Reyee validation", () => {
      const originalVendorId = routers[0].vendor_id;

      try {
        (routers[0] as typeof routers[0]).vendor_id = 999;

        const result = validateDevices();

        expect(result.rejectedDevices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sku: routers[0].sku,
              errors: expect.arrayContaining([
                expect.stringContaining("vendor_id"),
              ]),
            }),
          ])
        );

        expect(result.validDevices).toHaveLength(9);
      } finally {
        routers[0].vendor_id = originalVendorId;
      }
    });
  });
});

import { findProductLineId } from "../../scripts/seed-reyee-devices";
import type { PoolClient } from "pg";

describe("AC3 — Reyee product-line resolution", () => {
  test("resolves the product line using vendor, category, and name", async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ product_line_id: 42 }],
    });

    const client = { query } as unknown as PoolClient;

    const result = await findProductLineId(client, {
      vendor_id: 4,
      category: "gateway_router",
      product_line: "600 Mbps Cloud Gateways",
    });

    expect(result).toBe(42);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM product_line"),
      [4, "gateway_router", "600 Mbps Cloud Gateways"]
    );
  });

  test("rejects a device whose product line does not exist", async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 0,
      rows: [],
    });

    const client = { query } as unknown as PoolClient;

    await expect(
      findProductLineId(client, {
        vendor_id: 4,
        category: "switch",
        product_line: "Nonexistent Product Line",
      })
    ).rejects.toThrow("Product line not found");
  });
});

import {
  resolveCapabilityId,
  linkCapabilities,
} from "../../scripts/seed-reyee-devices";

describe("AC5 — Capability resolution and linking", () => {
  test("reuses an existing capability ID", async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ capability_id: 7 }],
    });

    const client = { query } as unknown as PoolClient;

    const result = await resolveCapabilityId(client, "router");

    expect(result).toBe(7);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM capability"),
      ["router"]
    );

    expect(query).toHaveBeenCalledTimes(1);
  });

  test("creates a capability when none exists", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ next_id: 12 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const client = { query } as unknown as PoolClient;

    const result = await resolveCapabilityId(client, "controller");

    expect(result).toBe(12);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO capability"),
      [12, "controller"]
    );
  });

  test("links device capabilities without duplicate junction rows", async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT capability_id")) {
        return {
          rowCount: 1,
          rows: [{ capability_id: 5 }],
        };
      }

      return { rowCount: 1, rows: [] };
    });

    const client = { query } as unknown as PoolClient;

    await linkCapabilities(client, 100, ["router"]);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO device_capability"),
      [100, 5]
    );

    const insertion = query.mock.calls.find(
      ([sql]) => sql.includes("INSERT INTO device_capability")
    );

    expect(insertion?.[0]).toContain("ON CONFLICT");
  });
});

import { upsertDevice } from "../../scripts/seed-reyee-devices";

describe("AC1 and AC7 — Device insertion and updates", () => {
  test("inserts a Reyee device with its core attributes and product-line ID", async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ device_id: 101, inserted: true }],
    });

    const client = { query } as unknown as PoolClient;
    const device = routers[0];

    const result = await upsertDevice(client, device, 42);

    expect(result).toEqual({
      deviceId: 101,
      inserted: true,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO device"),
      [
        device.vendor_id,
        device.sku,
        device.price,
        device.price_updated_at ?? null,
        device.name,
        device.description,
        device.is_rack_mountable,
        device.u_height,
        device.lifecycle_status,
        device.eos_date,
        device.eol_date,
        42,
      ]
    );
  });

  test("updates an existing device instead of creating a duplicate", async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ device_id: 101, inserted: false }],
    });

    const client = { query } as unknown as PoolClient;

    const result = await upsertDevice(client, routers[0], 42);

    expect(result).toEqual({
      deviceId: 101,
      inserted: false,
    });

    const sql = query.mock.calls[0][0];

    expect(sql).toContain("ON CONFLICT (vendor_id, sku)");
    expect(sql).toContain("DO UPDATE SET");
    expect(sql).toContain("product_line_id = EXCLUDED.product_line_id");
  });
});

import {
  upsertGatewayRouterSpecs,
  upsertSwitchSpecs,
  upsertApSpecs,
  upsertFirewallSpecs,
  upsertControllerSpecs,
} from "../../scripts/seed-reyee-devices";

describe("AC2 — Category-specific specification insertion", () => {
  const makeClient = () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    return {
      query,
      client: { query } as unknown as PoolClient,
    };
  };

  test("inserts gateway/router specifications", async () => {
    const { query, client } = makeClient();

    await upsertGatewayRouterSpecs(
      client,
      101,
      routers[0].gateway_router_specs
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO gateway_router_specifications"),
      expect.arrayContaining([101])
    );

    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (device_id)");
  });

  test("inserts switch specifications", async () => {
    const { query, client } = makeClient();

    await upsertSwitchSpecs(client, 102, switches[0].switch_specs);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO switch_specifications"),
      expect.arrayContaining([102])
    );

    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (device_id)");
  });

  test("inserts access point specifications", async () => {
    const { query, client } = makeClient();

    await upsertApSpecs(client, 103, aps[0].ap_specs);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO ap_specifications"),
      expect.arrayContaining([103])
    );

    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (device_id)");
  });

  test("inserts firewall specifications for supported gateways", async () => {
    const { query, client } = makeClient();

    const firewall = routers.find(
      (device) => device.sku === "RG-EG305GH-P-E"
    );

    expect(firewall?.firewall_specs).toBeDefined();

    await upsertFirewallSpecs(client, 104, firewall!.firewall_specs!);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO firewall_specifications"),
      expect.arrayContaining([104, 170])
    );

    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (device_id)");
  });

  test("inserts integrated controller specifications", async () => {
    const { query, client } = makeClient();

    await upsertControllerSpecs(
      client,
      105,
      routers[0].controller_specs
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO controller_specifications"),
      expect.arrayContaining([105, "integrated", 300])
    );

    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (device_id)");
  });
});

import { seedOneDevice } from "../../scripts/seed-reyee-devices";
import { pool } from "../../src/config/database";

describe("AC6 — Transaction rollback", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("rolls back when product-line resolution fails", async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (sql.includes("FROM product_line")) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const release = jest.fn();

    jest.spyOn(pool, "connect").mockResolvedValue({
      query,
      release,
    } as any);

    await expect(
      seedOneDevice(routers[0])
    ).rejects.toThrow("Product line not found");

    const statements = query.mock.calls.map(
      ([sql]) => sql.trim()
    );

    expect(statements[0]).toBe("BEGIN");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("AC6 — Rollback after partial insertion", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("rolls back when specification insertion fails after device upsert", async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (sql.includes("FROM product_line")) {
        return {
          rowCount: 1,
          rows: [{ product_line_id: 42 }],
        };
      }

      if (sql.includes("FROM device") && sql.includes("FOR UPDATE")) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("INSERT INTO device")) {
        return {
          rowCount: 1,
          rows: [{ device_id: 101, inserted: true }],
        };
      }

      if (sql.includes("INSERT INTO gateway_router_specifications")) {
        throw new Error("Simulated specification insertion failure");
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const release = jest.fn();

    jest.spyOn(pool, "connect").mockResolvedValue({
      query,
      release,
    } as any);

    await expect(
      seedOneDevice(routers[0])
    ).rejects.toThrow("Simulated specification insertion failure");

    const statements = query.mock.calls.map(
      ([sql]) => sql.trim()
    );

    expect(
      statements.some(sql => sql.includes("INSERT INTO device"))
    ).toBe(true);

    expect(
      statements.some(sql =>
        sql.includes("INSERT INTO gateway_router_specifications")
      )
    ).toBe(true);

    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");

    expect(release).toHaveBeenCalledTimes(1);
  });
});

import {
  cleanupStaleSpecifications,
} from "../../scripts/seed-reyee-devices";

describe("AC7 — Specification synchronization", () => {
  test("removes obsolete controller and firewall specifications", async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [],
    });

    const client = { query } as unknown as PoolClient;

    const device = {
      ...routers[0],
      controller_specs: undefined,
      firewall_specs: undefined,
    };

    await cleanupStaleSpecifications(client, 101, device);

    const statements = query.mock.calls.map(
      ([sql]) => String(sql)
    );

    expect(
      statements.some(sql =>
        sql.includes("DELETE FROM controller_specifications")
      )
    ).toBe(true);

    expect(
      statements.some(sql =>
        sql.includes("DELETE FROM firewall_specifications")
      )
    ).toBe(true);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "DELETE FROM controller_specifications"
      ),
      [101]
    );
  });

  test("preserves controller and firewall rows when specifications remain", async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [],
    });

    const client = { query } as unknown as PoolClient;

    const device = routers.find(
      d => d.sku === "RG-EG305GH-P-E"
    );

    expect(device).toBeDefined();

    await cleanupStaleSpecifications(client, 102, device!);

    const statements = query.mock.calls.map(
      ([sql]) => String(sql)
    );

    expect(
      statements.some(sql =>
        sql.includes("DELETE FROM controller_specifications")
      )
    ).toBe(false);

    expect(
      statements.some(sql =>
        sql.includes("DELETE FROM firewall_specifications")
      )
    ).toBe(false);
  });
});

import {
  upsertDeviceWithSpecs,
} from "../../scripts/seed-reyee-devices";

describe("AC2 and AC7 — Multi-role device orchestration", () => {
  test("inserts gateway, firewall, controller, and capabilities under one device ID", async () => {
    const gateway = routers.find(
      d => d.sku === "RG-EG305GH-P-E"
    );

    expect(gateway).toBeDefined();

    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM device") && sql.includes("FOR UPDATE")) {
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("INSERT INTO device (")) {
        return {
          rowCount: 1,
          rows: [{ device_id: 201, inserted: true }],
        };
      }

      if (sql.includes("SELECT capability_id")) {
        return {
          rowCount: 1,
          rows: [{ capability_id: 5 }],
        };
      }

      return { rowCount: 1, rows: [] };
    });

    const client = { query } as unknown as PoolClient;

    const result = await upsertDeviceWithSpecs(
      client,
      gateway!,
      42
    );

    expect(result).toEqual({
      deviceId: 201,
      inserted: true,
    });

    const statements = query.mock.calls.map(
      ([sql]) => String(sql)
    );

    for (const table of [
      "gateway_router_specifications",
      "firewall_specifications",
      "controller_specifications",
      "device_capability",
    ]) {
      expect(
        statements.some(sql => sql.includes(`INSERT INTO ${table}`))
      ).toBe(true);
    }

    for (const table of [
      "gateway_router_specifications",
      "firewall_specifications",
      "controller_specifications",
    ]) {
      const calls = query.mock.calls.filter(
        ([sql]) => String(sql).includes(`INSERT INTO ${table}`)
      );

      expect(calls).toHaveLength(1);
      expect(calls[0][1][0]).toBe(201);
    }
  });
});

import {
  printIngestionSummary,
} from "../../scripts/seed-reyee-devices";

describe("AC8 — Ingestion summary", () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("reports inserted, updated, and skipped counts", () => {
    printIngestionSummary({
      total: 10,
      inserted: 8,
      updated: 1,
      skipped: 1,
    });

    const output = logSpy.mock.calls
      .map(args => args.join(" "))
      .join("\n");

    expect(output).toContain("REYEE INGESTION SUMMARY");
    expect(output).toContain("Total devices: 10");
    expect(output).toContain("Inserted: 8");
    expect(output).toContain("Updated: 1");
    expect(output).toContain("Skipped: 1");
  });

  test("reports zero inserted devices on a repeat run", () => {
    printIngestionSummary({
      total: 10,
      inserted: 0,
      updated: 10,
      skipped: 0,
    });

    const output = logSpy.mock.calls
      .map(args => args.join(" "))
      .join("\n");

    expect(output).toContain("Inserted: 0");
    expect(output).toContain("Updated: 10");
    expect(output).toContain("Skipped: 0");
  });
});

import { verifyReyeeVendor } from "../../scripts/seed-reyee-devices";

describe("AC4 — Reyee vendor initialization", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("reuses the existing Ruijie vendor", async () => {
    const query = jest.spyOn(pool, "query").mockResolvedValue({
      rowCount: 1,
      rows: [{ vendor_id: 4, name: "Ruijie" }],
    } as any);

    await expect(verifyReyeeVendor()).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(2);

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO vendor")
      )
    ).toBe(false);
  });

  test("creates the Ruijie vendor when missing", async () => {
    const query = jest.spyOn(pool, "query")
      .mockResolvedValueOnce({
        rowCount: 0,
        rows: [],
      } as any)
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [],
      } as any)
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ vendor_id: 4, name: "Ruijie" }],
      } as any);

    await expect(verifyReyeeVendor()).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO vendor"),
      [4, "Ruijie", false, ["dashboard"]]
    );
  });

  test("rejects conflicting vendor identities", async () => {
    const query = jest.spyOn(pool, "query").mockResolvedValue({
      rowCount: 1,
      rows: [{ vendor_id: 4, name: "Another Vendor" }],
    } as any);

    await expect(verifyReyeeVendor()).rejects.toThrow(
      "Reyee ingestion requires vendor_id 4 to belong to Ruijie"
    );

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO vendor")
      )
    ).toBe(false);
  });

  test("rejects Ruijie assigned to another vendor ID", async () => {
    jest.spyOn(pool, "query").mockResolvedValue({
      rowCount: 1,
      rows: [{ vendor_id: 7, name: "Ruijie" }],
    } as any);

    await expect(verifyReyeeVendor()).rejects.toThrow(
      "Reyee ingestion requires vendor_id 4 to belong to Ruijie"
    );
  });
});

describe("AC7 — Existing device transaction", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("updates an existing Reyee device and commits successfully", async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rowCount: null, rows: [] };
      }

      if (sql.includes("FROM product_line")) {
        return {
          rowCount: 1,
          rows: [{ product_line_id: 42 }],
        };
      }

      if (sql.includes("FROM device") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{ device_id: 101 }],
        };
      }

      if (sql.includes("INSERT INTO device (")) {
        return {
          rowCount: 1,
          rows: [{ device_id: 101, inserted: false }],
        };
      }

      if (sql.includes("SELECT capability_id")) {
        return {
          rowCount: 1,
          rows: [{ capability_id: 5 }],
        };
      }

      return { rowCount: 1, rows: [] };
    });

    const release = jest.fn();

    jest.spyOn(pool, "connect").mockResolvedValue({
      query,
      release,
    } as any);

    const result = await seedOneDevice(routers[0]);

    expect(result).toEqual({
      deviceId: 101,
      inserted: false,
    });

    const statements = query.mock.calls.map(
      ([sql]) => String(sql).trim()
    );

    expect(statements[0]).toBe("BEGIN");
    expect(statements).toContain("COMMIT");
    expect(statements).not.toContain("ROLLBACK");

    expect(
      statements.some(sql =>
        sql.includes("INSERT INTO controller_specifications")
      )
    ).toBe(true);

    expect(release).toHaveBeenCalledTimes(1);
  });
});

import { main } from "../../scripts/seed-reyee-devices";

describe("AC6 and AC8 — Complete ingestion loop", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("continues after one device fails and reports accurate counts", async () => {
    let nextDeviceId = 100;
    let deviceAttempts = 0;

    const query = jest.fn().mockImplementation(async (sql: string) => {
      const statement = String(sql).trim();

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) {
        return { rowCount: null, rows: [] };
      }

      if (statement.includes("FROM product_line")) {
        return {
          rowCount: 1,
          rows: [{ product_line_id: 42 }],
        };
      }

      if (
        statement.includes("FROM device") &&
        statement.includes("FOR UPDATE")
      ) {
        return { rowCount: 0, rows: [] };
      }

      if (statement.includes("INSERT INTO device (")) {
        deviceAttempts++;

        if (deviceAttempts === 3) {
          throw new Error("Simulated device insertion failure");
        }

        return {
          rowCount: 1,
          rows: [{
            device_id: ++nextDeviceId,
            inserted: true,
          }],
        };
      }

      if (statement.includes("SELECT capability_id")) {
        return {
          rowCount: 1,
          rows: [{ capability_id: 5 }],
        };
      }

      return { rowCount: 1, rows: [] };
    });

    jest.spyOn(pool, "connect").mockImplementation(
      async () => ({
        query,
        release: jest.fn(),
      }) as any
    );

    jest.spyOn(pool, "query").mockImplementation(
      async (sql: any) => {
        const statement = String(sql);

        if (statement.includes("FROM vendor")) {
          return {
            rowCount: 1,
            rows: [{ vendor_id: 4, name: "Ruijie" }],
          } as any;
        }

        if (statement.includes("SELECT NOW()")) {
          return {
            rowCount: 1,
            rows: [{ now: new Date() }],
          } as any;
        }

        throw new Error(`Unexpected pool query: ${statement}`);
      }
    );

    const logSpy = jest.spyOn(console, "log")
      .mockImplementation(() => {});

    const errorSpy = jest.spyOn(console, "error")
      .mockImplementation(() => {});

    await main();

    const output = logSpy.mock.calls
      .map(args => args.join(" "))
      .join("\n");

    expect(output).toContain("Total devices: 10");
    expect(output).toContain("Inserted: 9");
    expect(output).toContain("Updated: 0");
    expect(output).toContain("Skipped: 1");

    expect(deviceAttempts).toBe(10);

    expect(
      errorSpy.mock.calls.some(args =>
        args.join(" ").includes("Simulated device insertion failure")
      )
    ).toBe(true);

    const statements = query.mock.calls.map(
      ([sql]) => String(sql).trim()
    );

    expect(
      statements.filter(sql => sql === "COMMIT")
    ).toHaveLength(9);

    expect(
      statements.filter(sql => sql === "ROLLBACK")
    ).toHaveLength(1);
  });
});
