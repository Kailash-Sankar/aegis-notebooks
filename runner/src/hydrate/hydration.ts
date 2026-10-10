import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { assertIdentifier } from "../warehouse/ingested.js";
import type { Warehouse } from "../warehouse/client.js";
import type { WorkspacePaths } from "../workspace/paths.js";
import {
  readManifest,
  writeManifest,
  type HydratedPartition,
  type HydratedTable,
  type HydrationManifest,
} from "./manifest.js";

/**
 * Hydration (design §4.8): export a window of the warehouse to Parquet on local
 * disk so DuckDB can query it without touching ClickHouse at read time.
 *
 * - default rolling **90 days**, overridable;
 * - consistent **as of** a watermark `T`;
 * - **partition-granular incremental**: closed month partitions are cached and
 *   skipped on refresh; the open (current) month is re-exported; new partitions
 *   are added. (Closed partitions are assumed immutable — late data rewriting
 *   them is a known limitation.)
 */

export interface HydrateTableSpec {
  table: string;
  view: string;
  /** Event-time column for windowing/partitioning; omit for a full export. */
  timeColumn?: string;
}

export const HYDRATE_TABLES: HydrateTableSpec[] = [
  {
    table: "prepared_stream_events",
    view: "hydrate_prepared_stream_events",
    timeColumn: "started_at",
  },
  { table: "aggregated_stream_daily", view: "hydrate_aggregated_stream_daily", timeColumn: "day" },
  { table: "aggregated_channel_totals", view: "hydrate_aggregated_channel_totals" },
];

export interface HydrationDeps {
  warehouse: Warehouse;
  paths: WorkspacePaths;
}

export interface HydrationOptions {
  days?: number;
  asOf?: string;
  tables?: string[];
}

const DAY_MS = 86_400_000;

function specsFor(tables?: string[]): HydrateTableSpec[] {
  if (!tables || tables.length === 0) return HYDRATE_TABLES;
  const wanted = new Set(tables);
  return HYDRATE_TABLES.filter((spec) => wanted.has(spec.table));
}

function monthStart(partition: string): string {
  return `${partition}-01`;
}

function monthEnd(partition: string): string {
  const [y, m] = partition.split("-").map((v) => Number.parseInt(v, 10));
  if (y === undefined || m === undefined) throw new Error(`bad partition ${partition}`);
  // Date month is 0-based, so passing the 1-based month yields the next month.
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** Month partitions ("YYYY-MM") covering [from, to). */
export function monthPartitions(fromIso: string, toIso: string): string[] {
  const to = new Date(toIso);
  const cursor = new Date(fromIso);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  const out: string[] = [];
  while (cursor < to) {
    out.push(
      `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`,
    );
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

function exportSql(
  database: string,
  spec: HydrateTableSpec,
  partition: string,
): string {
  const db = assertIdentifier(database);
  const table = assertIdentifier(spec.table);
  if (!spec.timeColumn) return `SELECT * FROM ${db}.${table}`;
  const time = assertIdentifier(spec.timeColumn);
  return (
    `SELECT * FROM ${db}.${table} ` +
    `WHERE ${time} >= '${monthStart(partition)}' AND ${time} < '${monthEnd(partition)}'`
  );
}

function checksum(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

export async function hydrate(
  deps: HydrationDeps,
  options: HydrationOptions = {},
): Promise<HydrationManifest> {
  const days = options.days ?? 90;
  const asOf = options.asOf ?? new Date().toISOString();
  const to = new Date(asOf);
  const from = new Date(to.getTime() - days * DAY_MS);
  const specs = specsFor(options.tables);
  const currentMonth = asOf.slice(0, 7);
  const existing = await readManifest(deps.paths.hydrateManifest);

  const tables: Record<string, HydratedTable> = {};
  for (const spec of specs) {
    await mkdir(deps.paths.hydrateTableDir(spec.table), { recursive: true });
    const prev = existing?.tables[spec.table];
    const partitions: Record<string, HydratedPartition> = {};

    const wanted = spec.timeColumn
      ? monthPartitions(from.toISOString(), to.toISOString())
      : ["all"];

    for (const partition of wanted) {
      const cached = prev?.partitions[partition];
      const closed = spec.timeColumn ? partition < currentMonth : false;
      // Closed + cached => cannot have changed; reuse without re-exporting.
      if (cached && closed) {
        partitions[partition] = cached;
        continue;
      }
      const bytes = await deps.warehouse.exportParquet(
        exportSql(deps.warehouse.database, spec, partition),
      );
      await writeFile(deps.paths.hydrateParquet(spec.table, partition), bytes);
      partitions[partition] = {
        partition,
        file: `hydrate/${spec.table}/${partition}.parquet`,
        bytes: bytes.length,
        checksum: checksum(bytes),
        asOf,
      };
    }

    // Drop cached partitions that fell out of the window.
    for (const partition of Object.keys(prev?.partitions ?? {})) {
      if (!(partition in partitions)) {
        await rm(deps.paths.hydrateParquet(spec.table, partition), { force: true });
      }
    }

    tables[spec.table] = { view: spec.view, watermark: asOf, partitions };
  }

  const manifest: HydrationManifest = {
    workspaceId: basename(deps.paths.root),
    asOf,
    window: { from: from.toISOString(), to: to.toISOString(), days },
    tables,
    createdAt: new Date().toISOString(),
  };
  await writeManifest(deps.paths.hydrateManifest, manifest);
  return manifest;
}
