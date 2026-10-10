import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { withDuckdbLock } from "../workspace/ducklock.js";
import type { WorkspacePaths } from "../workspace/paths.js";
import { assertIdentifier } from "../warehouse/ingested.js";
import type { HydrationManifest } from "./manifest.js";

const execFileAsync = promisify(execFile);

/**
 * Create (or replace) a DuckDB view per hydrated table, reading the local
 * Parquet glob. Views are named `hydrate_<table>`; queries run with the
 * workspace root as cwd so the relative glob resolves.
 */
export async function createHydrateViews(
  config: Config,
  paths: WorkspacePaths,
  manifest: HydrationManifest,
): Promise<string[]> {
  const statements: string[] = [];
  const views: string[] = [];
  for (const [table, hydrated] of Object.entries(manifest.tables)) {
    if (Object.keys(hydrated.partitions).length === 0) continue;
    const view = assertIdentifier(hydrated.view);
    const glob = `hydrate/${assertIdentifier(table)}/*.parquet`;
    statements.push(
      `CREATE OR REPLACE VIEW "${view}" AS SELECT * FROM read_parquet('${glob}')`,
    );
    views.push(view);
  }
  if (statements.length === 0) return [];

  await withDuckdbLock(paths.duckdb, () =>
    execFileAsync(config.DUCKDB_CLI, [paths.duckdb, "-c", statements.join("; ")], {
      cwd: dirname(paths.duckdb),
    }),
  );
  return views;
}
