import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The hydration manifest is the authority for what is cached locally (design
 * §4.8). It maps each warehouse table to per-partition Parquet files, so a
 * refresh can skip partitions that cannot have changed.
 */
export interface HydratedPartition {
  partition: string;
  /** Path relative to the workspace root (used by DuckDB `read_parquet`). */
  file: string;
  bytes: number;
  checksum: string;
  asOf: string;
}

export interface HydratedTable {
  /** DuckDB view name that reads the partition glob. */
  view: string;
  watermark: string;
  partitions: Record<string, HydratedPartition>;
}

export interface HydrationManifest {
  workspaceId: string;
  asOf: string;
  window: { from: string; to: string; days: number };
  tables: Record<string, HydratedTable>;
  createdAt: string;
}

export async function readManifest(
  path: string,
): Promise<HydrationManifest | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as HydrationManifest;
  } catch {
    return null;
  }
}

export async function writeManifest(
  path: string,
  manifest: HydrationManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await rename(tmp, path);
}
