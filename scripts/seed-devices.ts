async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await import("./seed-omada-devices.js");
    return;
  }

  if (args.length === 1 && args[0] === "--cisco") {
    const { seedCiscoCatalog } = await import("./seed-cisco-devices.js");
    await seedCiscoCatalog();
    return;
  }

  throw new Error("Usage: npm run seed:devices -- [--cisco]");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
