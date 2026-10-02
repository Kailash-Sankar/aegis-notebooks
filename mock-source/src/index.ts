import { applySchema, openDb, seed } from "./db.js";
import { startGenerator } from "./generator.js";
import { listen } from "./server.js";

/**
 * Mock OLTP source: SQLite + a mutation generator + a cursor-paginated HTTP
 * API. See docs/design/ingestion-platform.md §4.1.
 */
async function main(): Promise<void> {
  const port = Number(process.env.MOCK_PORT ?? 8099);
  const dbPath = process.env.MOCK_DB ?? "mock-source/data/mock.db";
  const generate = (process.env.MOCK_GENERATE ?? "1") !== "0";

  const db = openDb(dbPath);
  applySchema(db);
  seed(db);

  const generator = generate
    ? startGenerator(db, {
        intervalMs: Number(process.env.MOCK_INTERVAL_MS ?? 1500),
        latePercent: Number(process.env.MOCK_LATE_PERCENT ?? 0.15),
        driftAfterTicks: Number(process.env.MOCK_DRIFT_AFTER_TICKS ?? 0),
        seed: Number(process.env.MOCK_SEED ?? 42),
      })
    : null;

  const { url } = await listen(
    db,
    { faultRate: Number(process.env.MOCK_FAULT_RATE ?? 0) },
    port,
  );

  console.log(`[mock-source] db=${dbPath} generate=${generate}`);
  console.log(`[mock-source] listening on ${url}`);
  console.log(`[mock-source]   GET ${url}/v1/streamers?limit=5`);

  const shutdown = (): void => {
    generator?.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error("[mock-source] fatal:", err);
  process.exit(1);
});
