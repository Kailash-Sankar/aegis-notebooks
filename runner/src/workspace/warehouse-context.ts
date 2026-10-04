import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { HydrationManifest } from "../hydrate/manifest.js";
import type { WorkspacePaths } from "./paths.js";

/**
 * Advertise the local warehouse to the agent. If the workspace has been
 * hydrated, DuckDB exposes `hydrate_<table>` views over a local Parquet window;
 * the agent should know they exist (and their freshness) instead of
 * re-deriving everything from raw uploads.
 */
export async function buildWarehouseContext(
  paths: WorkspacePaths,
): Promise<string | null> {
  if (!existsSync(paths.hydrateManifest)) return null;
  let manifest: HydrationManifest;
  try {
    manifest = JSON.parse(
      await readFile(paths.hydrateManifest, "utf8"),
    ) as HydrationManifest;
  } catch {
    return null;
  }
  const tables = Object.entries(manifest.tables ?? {});
  if (tables.length === 0) return null;

  const lines = [
    "# Local warehouse (hydrated)",
    "",
    "A window of the analytics warehouse is cached locally as Parquet and exposed",
    "as DuckDB views you can query with `duckdb_query`.",
    `Data as of ${manifest.asOf} (window: last ${manifest.window.days} days).`,
    "",
    "| DuckDB view | partitions | refreshed |",
    "|---|---|---|",
  ];
  for (const [table, hydrated] of tables) {
    lines.push(
      `| \`${hydrated.view}\` | ${Object.keys(hydrated.partitions).length} | ${hydrated.watermark} |`,
    );
  }
  lines.push(
    "",
    "Headline findings are in `gold_insights` and served at",
    "`GET /workspaces/<id>/insights`. Prefer these views over re-deriving from",
    "raw files when they cover the question.",
  );
  return lines.join("\n");
}
