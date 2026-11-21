import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { pool } from "../src/config/database";
import { deviceSchemas, type DeviceSchemas } from "../db/catalog/schema/generated-schema";
import {
  findProductLineId,
  linkCapabilities,
  upsertApSpecs,
  upsertDevice,
  upsertFirewallSpecs,
  upsertGatewayRouterSpecs,
  upsertSwitchSpecs,
} from "./device-seed-queries";

const sources = [
  { file: "cisco-routers.json", category: "gateway_router" },
  { file: "cisco-switches.json", category: "switch" },
  { file: "cisco-aps.json", category: "ap" },
  { file: "cisco-controllers.json", category: "controller", optional: true },
] as const;

type CiscoDevice = Extract<
  DeviceSchemas,
  { category: (typeof sources)[number]["category"] }
>;

type ControllerSpecs = Extract<
  CiscoDevice,
  { category: "controller" }
>["controller_specs"];

function readDevices() {
  const devices: CiscoDevice[] = [];
  let skipped = 0;

  for (const source of sources) {
    let fileContents: string;
    try {
      fileContents = readFileSync(
        resolve(__dirname, "../db/catalog/cisco", source.file),
        "utf8",
      );
    } catch (error) {
      if ("optional" in source && (error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const records: unknown = JSON.parse(fileContents);
    if (!Array.isArray(records)) {
      throw new Error(`${source.file} must contain an array`);
    }

    for (const [index, entry] of records.entries()) {
      const label = `${source.file} #${index + 1} ${entry?.sku ?? "(missing SKU)"}`;
      const result = deviceSchemas.safeParse(entry);

      if (!result.success) {
        skipped++;
        console.error(`SKIPPED ${label}`, result.error.issues);
        continue;
      }

      const device = result.data;
      if (
        device.category !== source.category ||
        device.vendor_id !== 6 ||
        !device.sku.trim() ||
        !device.name.trim() ||
        (device.category !== "controller" && !device.product_line?.trim())
      ) {
        skipped++;
        console.error(`SKIPPED ${label}: invalid Cisco vendor, category, or core field`);
        continue;
      }

      devices.push(device);
    }
  }

  return { devices, skipped };
}

async function upsertControllerSpecs(
  client: PoolClient,
  id: number,
  specs: ControllerSpecs,
) {
  const columns = [
    "controller_type",
    "max_managed_aps",
    "max_managed_switches",
    "max_managed_gateways",
    "max_managed_aps_and_switches",
    "max_managed_clients",
    "lan_ports",
    "power_method",
    "max_power_draw_w",
  ] as const;

  await client.query(
    `INSERT INTO controller_specifications (device_id, ${columns.join(", ")})
     VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(", ")})
     ON CONFLICT (device_id) DO UPDATE SET
       ${columns.map(column => `${column} = EXCLUDED.${column}`).join(", ")}`,
    [id, ...columns.map(column => specs[column] ?? null)],
  );
}

async function syncSpecs(client: PoolClient, id: number, device: CiscoDevice) {
  const gateway = device.category === "gateway_router" ? device : undefined;
  const switchSpecs = device.category === "switch" ? device.switch_specs : gateway?.switch_specs;
  const apSpecs = device.category === "ap" ? device.ap_specs : undefined;
  const controller = device.category === "controller" ? device.controller_specs : gateway?.controller_specs;

  const rows = [
    ["gateway_router_specifications", gateway?.gateway_router_specs],
    ["firewall_specifications", gateway?.firewall_specs],
    ["switch_specifications", switchSpecs],
    ["ap_specifications", apSpecs],
    ["controller_specifications", controller],
  ] as const;

  for (const [table, specs] of rows) {
    if (!specs) await client.query(`DELETE FROM ${table} WHERE device_id = $1`, [id]);
  }

  if (gateway) {
    await upsertGatewayRouterSpecs(client, id, gateway.gateway_router_specs);
    if (gateway.firewall_specs) await upsertFirewallSpecs(client, id, gateway.firewall_specs);
  }

  if (switchSpecs) {
    await upsertSwitchSpecs(client, id, switchSpecs);
    await client.query(
      "UPDATE switch_specifications SET poe_standard = $2 WHERE device_id = $1",
      [id, switchSpecs.poe_standard ?? null],
    );
  }

  if (apSpecs) {
    await upsertApSpecs(client, id, apSpecs);
    await client.query(
      "UPDATE ap_specifications SET poe_standard = $2 WHERE device_id = $1",
      [id, apSpecs.poe_standard ?? null],
    );
  }

  if (controller) await upsertControllerSpecs(client, id, controller);
}

async function seedDevice(device: CiscoDevice) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lineId = device.product_line ? await findProductLineId(client, device) : null;
    const result = await upsertDevice(client, device, lineId);
    await syncSpecs(client, result.deviceId, device);
    await linkCapabilities(client, result.deviceId, device.capabilities);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function seedCiscoCatalog() {
  try {
    const { devices, skipped: invalid } = readDevices();
    let inserted = 0;
    let updated = 0;
    let skipped = invalid;

    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");

    const vendor = await pool.query<{ vendor_id: number }>(
      `INSERT INTO vendor (name, need_controller)
       VALUES ($1, false)
       ON CONFLICT (name) DO UPDATE SET need_controller = EXCLUDED.need_controller
       RETURNING vendor_id`,
      ["Cisco Business"],
    );

    for (const device of devices) {
      try {
        const result = await seedDevice({ ...device, vendor_id: vendor.rows[0].vendor_id });
        if (result.inserted) inserted++;
        else updated++;
        console.log(`${result.inserted ? "INSERTED" : "UPDATED"} ${device.sku} (${result.deviceId})`);
      } catch (error) {
        skipped++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`SKIPPED ${device.sku}: ${message}`);
      }
    }

    console.log(`Inserted: ${inserted} | Updated: ${updated} | Skipped/errored: ${skipped}`);
    if (skipped > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
