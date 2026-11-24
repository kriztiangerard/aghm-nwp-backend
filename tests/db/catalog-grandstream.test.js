'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const catalogDir = path.resolve(__dirname, '../../db/catalog/grandstream');
const schemaDir = path.resolve(__dirname, '../../db/catalog/schema');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const deviceSchema = readJson(path.join(schemaDir, 'device-schemas.json'));
const productLineSchema = readJson(path.join(schemaDir, 'productline-schema.json'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(deviceSchema);
const validateLines = ajv.compile(productLineSchema);

const files = [
  ['grandstream-routers.json', 'gateway_router', 'gatewayRouterDevice', 7],
  ['grandstream-switches.json', 'switch', 'switchDevice', 24],
  ['grandstream-aps.json', 'ap', 'apDevice', 12],
];

const data = files.map(([file, category, def, count]) => ({
  file,
  category,
  count,
  validate: ajv.getSchema(`${deviceSchema.$id}#/$defs/${def}`),
  entries: readJson(path.join(catalogDir, file)),
}));

const lines = readJson(path.join(catalogDir, 'grandstream-productlines.json'));
const devices = data.flatMap((group) => group.entries);

const errors = (validate) =>
  JSON.stringify(validate.errors || [], null, 2);

test('SETUP-012: expected catalog counts', () => {
  assert.equal(lines.length, 16);

  for (const group of data) {
    assert.equal(group.entries.length, group.count, group.file);
  }

  assert.equal(devices.length, 43);
});

test('SETUP-012: product lines validate against schema', () => {
  assert.ok(validateLines(lines), errors(validateLines));
});

test('SETUP-012: every device validates against category schema', () => {
  for (const group of data) {
    assert.ok(group.validate, `Missing validator: ${group.file}`);

    for (const device of group.entries) {
      assert.ok(
        group.validate(device),
        `${device.sku || group.file}: ${errors(group.validate)}`
      );
    }
  }
});

test('SETUP-012: device categories match their files', () => {
  for (const group of data) {
    for (const device of group.entries) {
      assert.equal(device.category, group.category, device.sku);
    }
  }
});

test('SETUP-012: unique device SKUs and names', () => {
  const skus = devices.map((d) => d.sku);
  const names = devices.map((d) => d.name);

  assert.equal(new Set(skus).size, skus.length, 'Duplicate SKU');
  assert.equal(new Set(names).size, names.length, 'Duplicate name');
});

test('SETUP-012: product-line references resolve', () => {
  const known = new Set(
    lines.map((l) => `${l.vendor_id}|${l.category}|${l.name}`)
  );

  for (const device of devices) {
    const key =
      `${device.vendor_id}|${device.category}|${device.product_line}`;

    assert.ok(known.has(key), `${device.sku}: unknown product line`);
  }
});

test('SETUP-012: product-line names and ranks are unique per category', () => {
  const names = new Set();
  const ranks = new Set();

  for (const line of lines) {
    const nameKey = `${line.vendor_id}|${line.category}|${line.name}`;
    const rankKey = `${line.vendor_id}|${line.category}|${line.line_rank}`;

    assert.ok(!names.has(nameKey), `Duplicate line: ${nameKey}`);
    assert.ok(!ranks.has(rankKey), `Duplicate rank: ${rankKey}`);

    names.add(nameKey);
    ranks.add(rankKey);
  }
});

test('SETUP-012: vendor IDs are consistent', () => {
  const ids = new Set([
    ...lines.map((l) => l.vendor_id),
    ...devices.map((d) => d.vendor_id),
  ]);

  assert.equal(ids.size, 1, 'Multiple vendor IDs detected');
  assert.equal([...ids][0], 5, 'Unexpected Grandstream vendor ID');
});

test('SETUP-012: capability values are valid and unique', () => {
  const vocabulary = new Set(
    deviceSchema.$defs.coreDevice.properties.capabilities.items.enum
  );

  for (const device of devices) {
    const capabilities = device.capabilities || [];

    assert.equal(
      new Set(capabilities).size,
      capabilities.length,
      `${device.sku}: duplicate capabilities`
    );

    for (const capability of capabilities) {
      assert.ok(
        vocabulary.has(capability),
        `${device.sku}: unknown capability ${capability}`
      );
    }

    for (const [block, capability] of [
      ['switch_specs', 'switch'],
      ['firewall_specs', 'firewall'],
      ['controller_specs', 'controller'],
    ]) {
      if (device[block]) {
        assert.ok(
          capabilities.includes(capability),
          `${device.sku}: ${block} missing ${capability} capability`
        );
      }
    }
  }
});

test('SETUP-012: integrated switch port rules', () => {
  for (const device of devices) {
    if (device.gateway_router_specs && device.switch_specs) {
      assert.equal(
        device.gateway_router_specs.lan_ports,
        0,
        `${device.sku}: integrated switch requires lan_ports=0`
      );
    }
  }
});

test('SETUP-012: PoE port counts and budgets are consistent', () => {
  for (const device of devices) {
    if (!device.switch_specs) continue;

    const specs = device.switch_specs;

    assert.ok(
      specs.poe_ports <= specs.port_count,
      `${device.sku}: PoE ports exceed total ports`
    );

    if (specs.poe_ports > 0) {
      assert.ok(
        specs.poe_budget_w > 0,
        `${device.sku}: missing PoE budget`
      );
    }
  }
});

test('SETUP-012: source documentation exists', () => {
  const sourcePath = path.join(catalogDir, 'references', 'SOURCES.md');

  assert.ok(fs.existsSync(sourcePath), 'SOURCES.md missing');
  assert.ok(fs.readFileSync(sourcePath, 'utf8').trim().length > 0);
});
