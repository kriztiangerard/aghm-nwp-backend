
import "dotenv/config";
import type { PoolClient } from "pg";
import { pool } from "../src/config/database";

import routers from "../db/catalog/ubiquiti/unifi-routers.json";
import switches from "../db/catalog/ubiquiti/unifi-switches.json";
import aps from "../db/catalog/ubiquiti/unifi-aps.json";

import {
  deviceSchemas,
  type DeviceSchemas,
} from "../db/catalog/schema/generated-schema";

import {
  findProductLineId,
  linkCapabilities,
  upsertDevice,
  upsertGatewayRouterSpecs,
  upsertSwitchSpecs,
  upsertApSpecs,
  upsertFirewallSpecs,
  type DeviceResult,
} from "./device-seed-queries";

type DeviceSource = {
  name: string;
  devices: unknown[];
};

type RejectedDevice = {
  source: string;
  sku: string;
  errors: string[];
};

const sources: DeviceSource[] = [
  { name: "UniFi Routers", devices: routers },
  { name: "UniFi Switches", devices: switches },
  { name: "UniFi Access Points", devices: aps },
];

function validateDevices(): {
  validDevices: DeviceSchemas[];
  rejectedDevices: RejectedDevice[];
} {
  const validDevices: DeviceSchemas[] = [];
  const rejectedDevices: RejectedDevice[] = [];

  for (const source of sources) {
    console.log(`\nChecking ${source.name}...`);

    for (const device of source.devices) {
      const record =
        typeof device === "object" && device !== null
          ? (device as Record<string, unknown>)
          : {};

      const sku =
        typeof record.sku === "string" ? record.sku : "Unknown SKU";

      const result = deviceSchemas.safeParse(device);

      if (result.success) {
        validDevices.push(result.data);
        console.log(`PASS: ${sku}`);
      } else {
        rejectedDevices.push({
          source: source.name,
          sku,
          errors: result.error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`
          ),
        });

        console.log(`FAIL: ${sku}`);
      }
    }
  }

  return { validDevices, rejectedDevices };
}

// Remove specification rows that no longer match the incoming device.
async function cleanupStaleSpecifications(
  client: PoolClient,
  deviceId: number,
  device: any
): Promise<void> {
  const subtypeTables = {
    gateway_router: "gateway_router_specifications",
    switch: "switch_specifications",
    ap: "ap_specifications",
  } as const;

  for (const [category, table] of Object.entries(subtypeTables)) {
    if (category !== device.category) {
      await client.query(
        `DELETE FROM ${table} WHERE device_id = $1`,
        [deviceId]
      );
    }
  }

  if (device.category !== "gateway_router" || !device.firewall_specs) {
    await client.query(
      `DELETE FROM firewall_specifications WHERE device_id = $1`,
      [deviceId]
    );
  }
}

async function upsertDeviceWithSpecs(
  client: PoolClient,
  device: any,
  productLineId: number
): Promise<DeviceResult> {
  // Lock an existing device before cleaning up its related rows.
  const existing = await client.query(
    `SELECT device_id
     FROM device
     WHERE vendor_id = $1
       AND sku = $2
     FOR UPDATE`,
    [device.vendor_id, device.sku]
  );

  const existingDeviceId = existing.rows[0]?.device_id;

  if (existingDeviceId) {
    await cleanupStaleSpecifications(
      client,
      existingDeviceId,
      device
    );
  }

  const result = await upsertDevice(client, device, productLineId);
  const deviceId = result.deviceId;

  if (device.category === "gateway_router") {
    if (!device.gateway_router_specs) {
      throw new Error(`Missing gateway router specifications: ${device.sku}`);
    }

    await upsertGatewayRouterSpecs(
      client,
      deviceId,
      device.gateway_router_specs
    );

    if (device.firewall_specs) {
      await upsertFirewallSpecs(
        client,
        deviceId,
        device.firewall_specs
      );
    }
  } else if (device.category === "switch") {
    if (!device.switch_specs) {
      throw new Error(`Missing switch specifications: ${device.sku}`);
    }

    await upsertSwitchSpecs(
      client,
      deviceId,
      device.switch_specs
    );
  } else if (device.category === "ap") {
    if (!device.ap_specs) {
      throw new Error(`Missing AP specifications: ${device.sku}`);
    }

    await upsertApSpecs(client, deviceId, device.ap_specs);
  } else {
    throw new Error(`Unsupported device category: ${device.category}`);
  }

  await linkCapabilities(
    client,
    deviceId,
    device.capabilities ?? []
  );

  return result;
}

async function seedOneDevice(device: any): Promise<DeviceResult> {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const productLineId = await findProductLineId(client, device);

    const result = await upsertDeviceWithSpecs(
      client,
      device,
      productLineId
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return result;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  console.log("Starting UniFi device seeding...");

  // Validate all input records before performing any database writes.
  const { validDevices, rejectedDevices } = validateDevices();

  const totalDevices = sources.reduce(
    (total, source) => total + source.devices.length,
    0
  );

  let inserted = 0;
  let updated = 0;
  let skipped = rejectedDevices.length;

  console.log("\n========== VALIDATION SUMMARY ==========");
  console.log(`Total devices: ${totalDevices}`);
  console.log(`Passed: ${validDevices.length}`);
  console.log(`Failed: ${rejectedDevices.length}`);
  console.log("========================================");

  for (const device of rejectedDevices) {
    console.error(`\nSKIPPED: ${device.sku} (${device.source})`);
    for (const error of device.errors) {
      console.error(`  - ${error}`);
    }
  }

  const connection = await pool.query("SELECT NOW()");
  console.log("\nDatabase connection successful.");
  console.log("Database time:", connection.rows[0].now);

  for (const device of validDevices) {
    try {
      const result = await seedOneDevice(device);

      if (result.inserted) {
        inserted++;
        console.log(`INSERTED: ${device.sku} (ID: ${result.deviceId})`);
      } else {
        updated++;
        console.log(`UPDATED: ${device.sku} (ID: ${result.deviceId})`);
      }
    } catch (error) {
      skipped++;

      const message =
        error instanceof Error ? error.message : String(error);

      console.error(`SKIPPED: ${device.sku} — ${message}`);
    }
  }

  console.log("\n========== UNIFI INGESTION SUMMARY ==========");
  console.log(`Total devices: ${totalDevices}`);
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log("=============================================");
}

main()
  .catch((error) => {
    console.error("UniFi device catalog seeding failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
