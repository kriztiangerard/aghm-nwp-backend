import { deviceSchemas } from "../../db/catalog/schema/generated-schema";

import routers from "../../db/catalog/aruba/aruba-routers.json";
import switches from "../../db/catalog/aruba/aruba-switches.json";
import aps from "../../db/catalog/aruba/aruba-aps.json";

type CatalogDevice = {
  vendor_id: number;
  sku: string;
  category: string;
  product_line: string;
  [key: string]: unknown;
};

type CatalogSource = {
  name: string;
  devices: CatalogDevice[];
  category: string;
};

const sources: CatalogSource[] = [
  { name: "routers", devices: routers, category: "gateway_router" },
  { name: "switches", devices: switches, category: "switch" },
  { name: "aps", devices: aps, category: "ap" },
];

describe("NWP-SETUP-009 Aruba catalog validation", () => {
  test("all 26 Aruba devices pass schema validation", () => {
    const devices = sources.flatMap((source) => source.devices);

    expect(devices).toHaveLength(26);

    for (const device of devices) {
      const result = deviceSchemas.safeParse(device);

      expect(result.success).toBe(true);
    }
  });

  test("each catalog contains the correct device category", () => {
    for (const source of sources) {
      for (const device of source.devices) {
        expect(device.category).toBe(source.category);
      }
    }
  });

  test("all devices belong to Aruba vendor ID 1", () => {
    for (const source of sources) {
      for (const device of source.devices) {
        expect(device.vendor_id).toBe(1);
      }
    }
  });

  test("all SKUs are unique across the Aruba catalog", () => {
    const devices = sources.flatMap((source) => source.devices);
    const skus = devices.map((device) => device.sku);

    expect(new Set(skus).size).toBe(skus.length);
  });

  test("all devices have a product line", () => {
    for (const source of sources) {
      for (const device of source.devices) {
        expect(device.product_line.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("invalid device entries fail schema validation", () => {
    const invalid = {
      ...switches[0],
      sku: 12345,
      price: "invalid",
    };

    const result = deviceSchemas.safeParse(invalid);

    expect(result.success).toBe(false);
  });
});

describe("NWP-SETUP-009 AC4 malformed-entry handling", () => {
  test("rejects a malformed Aruba device while retaining valid devices", () => {
    const { validateDevices } =
      require("../../scripts/seed-aruba-devices");

    const switches =
      require("../../db/catalog/aruba/aruba-switches.json");

    const invalid = { ...switches[0] };
    delete invalid.sku;

    const logSpy = jest
      .spyOn(console, "log")
      .mockImplementation(() => {});

    switches.push(invalid);

    try {
      const { validDevices, rejectedDevices } = validateDevices();

      expect(validDevices).toHaveLength(26);
      expect(rejectedDevices).toHaveLength(1);

      expect(rejectedDevices[0].source).toBe("Aruba Switches");
      expect(rejectedDevices[0].sku).toBe("Unknown SKU");
      expect(rejectedDevices[0].errors.length).toBeGreaterThan(0);
      expect(
        rejectedDevices[0].errors.every(
          (error: string) => typeof error === "string" && error.length > 0
        )
      ).toBe(true);
    } finally {
      switches.pop();
      logSpy.mockRestore();
    }
  });
});
