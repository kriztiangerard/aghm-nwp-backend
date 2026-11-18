'use strict';
// Step 3 parity check: the single-process engine (run) vs the Step Functions pipeline
// (prepare -> handlers/vendor-plans once per vendor -> handlers/assemble), with a JSON round-trip between every stage
// to imitate what the state machine does to the data.
//
// Usage (from the repo root):
//   node scripts/parity-check.js <payload.json>                    real database (DATABASE_URL in .env, DB_SSL=true for RDS)
//   node scripts/parity-check.js <payload.json> --catalog <file>   offline; file is { "vendors": [...], "catalog": [...] }
//
// <payload.json> is a NetworkConfiguration (the request body), not a NormalizedInput.
// Exit code 0 = everything passed, 1 = a difference or a failure.

const fs = require('node:fs');
const path = require('node:path');
try { require('dotenv').config(); } catch (error) { /* dotenv is optional */ }

const ENGINE = path.resolve(__dirname, '../src/types/engine');
const engine = (file) => path.join(ENGINE, file);

const NOW = '2026-11-17T00:00:00.000Z';   // fixed, so lifecycle rules see the same date in every run
const STATE_LIMIT_BYTES = 262144;          // Step Functions: 256 KB per state input or output
const GENERIC = require(engine('params.js')).GENERIC_VENDOR_NAME;
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// ---- arguments ---------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const catalogFlag = args.indexOf('--catalog');
const catalogFile = catalogFlag >= 0 ? args[catalogFlag + 1] : null;
const skipIndex = catalogFlag >= 0 ? catalogFlag + 1 : -1;
const payloadPath = args.filter((arg, index) => !arg.startsWith('--') && index !== skipIndex)[0];
if (!payloadPath || (catalogFlag >= 0 && !catalogFile)) {
  console.error('Usage: node scripts/parity-check.js <payload.json> [--catalog <file.json>]');
  process.exit(1);
}

// ---- offline mode: replace the three repository readers BEFORE index.js and the handlers are required -------------
const repo = require(engine('catalog-repository.js'));
if (catalogFile) {
  const { vendors, catalog } = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  repo.loadVendors = async () => vendors;
  repo.loadEngineData = async () => ({ vendors, catalog });
  repo.loadVendorCatalog = async ({ vendor }) => ({
    catalog: catalog.filter((sku) => sameName(sku.vendor, vendor) || sameName(sku.vendor, GENERIC)),
  });
}

const { run, prepare } = require(engine('index.js'));
const vendorPlans = require(engine('handlers/vendor-plans.js')).handler;
const assemble = require(engine('handlers/assemble.js')).handler;
const { finalizeEngineResult } = require(engine('steps/assemble.js'));

// ---- helpers -----------------------------------------------------------------------------------------------------
const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));
const strip = ({ generatedAt, ...rest }) => rest;
const short = (value) => {
  const text = JSON.stringify(value);
  return text && text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

// Lists up to 25 differences between two JSON values.
function diff(single, pipeline, at = 'result', out = []) {
  if (out.length >= 25 || single === pipeline) return out;
  const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  if (kind(single) !== kind(pipeline)) {
    out.push(`${at}: ${kind(single)} (single) vs ${kind(pipeline)} (pipeline)`);
  } else if (kind(single) === 'array') {
    if (single.length !== pipeline.length) out.push(`${at}: length ${single.length} (single) vs ${pipeline.length} (pipeline)`);
    for (let i = 0; i < Math.min(single.length, pipeline.length); i += 1) diff(single[i], pipeline[i], `${at}[${i}]`, out);
  } else if (kind(single) === 'object') {
    for (const key of new Set([...Object.keys(single), ...Object.keys(pipeline)])) {
      if (!(key in single)) out.push(`${at}.${key}: only in pipeline`);
      else if (!(key in pipeline)) out.push(`${at}.${key}: only in single-process`);
      else diff(single[key], pipeline[key], `${at}.${key}`, out);
    }
  } else {
    out.push(`${at}: ${short(single)} (single) vs ${short(pipeline)} (pipeline)`);
  }
  return out;
}

// ---- the two paths -----------------------------------------------------------------------------------------------
async function singleProcess(payload) {
  const assembled = await run(payload, { now: NOW });
  return roundTrip(finalizeEngineResult(assembled, NOW));
}

async function pipeline(payload, sizes) {
  const track = (label, value) => { if (sizes) sizes.push({ label, bytes: bytesOf(value) }); return value; };

  const prepared = track('execution input (entry -> state machine)', roundTrip(await prepare(payload, { now: NOW })));

  const vendorResults = [];
  for (const vendor of prepared.vendors) {   // the Map keeps item order, so a sequential loop is equivalent
    const item = roundTrip({
      vendor,
      input: prepared.input,
      requirements: prepared.requirements,
      sharedLedger: prepared.ctx.ledger,
      now: prepared.now,
    });
    const output = roundTrip(await vendorPlans(item));
    track(`vendor-plans output: ${vendor.name}`, output);
    vendorResults.push(output);
  }

  const state = track('assemble input (state + vendorResults)', roundTrip({ ...prepared, vendorResults }));
  return track('final output (EngineResult)', roundTrip(await assemble(state)));
}

// DB mode only: the vendor-scoped SQL must return exactly that vendor's rows plus the Generic rows of the full load.
async function scopingCheck() {
  const full = await repo.loadEngineData({ now: NOW });
  const bySku = (list) => roundTrip([...list].sort((a, b) => a.sku.localeCompare(b.sku)));
  const problems = [];
  for (const vendor of full.vendors) {
    const scoped = (await repo.loadVendorCatalog({ vendor: vendor.name, now: NOW })).catalog;
    const expected = full.catalog.filter((sku) => sameName(sku.vendor, vendor.name) || sameName(sku.vendor, GENERIC));
    problems.push(...diff(bySku(expected), bySku(scoped), `catalog[${vendor.name}]`));
  }
  return problems;
}

// ---- run ---------------------------------------------------------------------------------------------------------
const results = [];
const report = (name, problems) => {
  results.push({ name, ok: problems.length === 0 });
  console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${name}`);
  problems.forEach((line) => console.log(`        ${line}`));
};

(async () => {
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  console.log(`Mode: ${catalogFile ? `offline (${catalogFile})` : 'real database'}   now=${NOW}\n`);

  const sizes = [];
  const single = strip(await singleProcess(payload));
  const piped = strip(await pipeline(payload, sizes));
  const pipedAgain = strip(await pipeline(payload, null));

  report('Parity: single-process result equals pipeline result', diff(single, piped));
  report('Determinism: pipeline run twice gives identical results', diff(piped, pipedAgain, 'run2'));
  if (!catalogFile) report('Scoping: vendor-scoped catalog equals the full catalog filtered per vendor', await scopingCheck());

  const worst = Math.max(...sizes.map((entry) => entry.bytes));
  console.log('\nPayload sizes (Step Functions limit is 256 KB per state input or output):');
  sizes.forEach((entry) => console.log(`  ${(entry.bytes / 1024).toFixed(1).padStart(7)} KB  ${String(Math.round((entry.bytes / STATE_LIMIT_BYTES) * 100)).padStart(3)}%  ${entry.label}`));
  report('Size: every stage payload is under 256 KB', worst >= STATE_LIMIT_BYTES ? [`largest payload is ${(worst / 1024).toFixed(1)} KB`] : []);

  const incomplete = piped.plans.filter((plan) => plan.complete === false).map((plan) => `${plan.vendor} ${plan.planType}`);
  console.log(`\nWhat this fixture exercised: ${piped.plans.length} plans, defaultVendor ${JSON.stringify(piped.defaultVendor)}`);
  console.log(`  incomplete plans (${incomplete.length}): ${incomplete.join(', ') || 'none'}`);
  console.log('  Not covered: handlers/entry.js and the CDK wiring (checked in Steps 5 and 6).');

  process.exitCode = results.every((entry) => entry.ok) ? 0 : 1;
})()
  .catch((error) => {
    console.error(`\nThe check could not finish: ${error.name}: ${error.message}`);
    if (error.name === 'ValidationError') console.error('The payload was rejected; fix it, or use a payload you know is accepted.');
    if (error.stack) console.error(error.stack.split('\n').slice(1, 6).join('\n'));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!catalogFile) { try { await repo.closeConnection(); } catch (error) { /* nothing to close */ } }
  });