import type { RawStore } from "../raw/store.js";
import type { ChunkManifest } from "../types.js";
import type { SourceContract } from "../sources/contract.js";
import { readContract, schemaFingerprint } from "../sources/contract.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Warehouse } from "./client.js";
import { ingestedAddColumnStatements, ingestedDdl, ingestedTableName } from "./ingested.js";
import { rebuildTransforms } from "./transform.js";

/**
 * The loader (design §4.7): apply a contract to one landed chunk and write it
 * to ClickHouse ingested. Deterministic — no LLM. Idempotent at the engine level
 * (content-addressed raw + `ReplacingMergeTree`).
 */

export interface LoadResult {
  table: string;
  rows: number;
}

export interface LoaderDeps {
  warehouse: Warehouse;
  raw: RawStore;
  workspaces: WorkspaceManager;
}

export function parseJsonl(body: Uint8Array): Array<Record<string, unknown>> {
  const text = Buffer.from(body).toString("utf8");
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return out;
}

/** ISO-8601 -> ClickHouse `DateTime64` text (space-separated, no trailing Z). */
function toDateTime(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "1970-01-01 00:00:00.000";
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function normalizeValue(value: unknown, type: string): unknown {
  if (value === undefined || value === null) return null;
  if (type.includes("DateTime") || type.startsWith("Date")) return toDateTime(value);
  if (/^(U?Int|Float)/.test(type)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return typeof value === "string" ? value : String(value);
}

/** The row's event-time value (for `_version`), falling back to ingest time. */
function versionFor(
  row: Record<string, unknown>,
  contract: SourceContract,
  ingestMs: number,
): number {
  const eventCol =
    Object.entries(contract.columns).find(([, c]) => c.eventTime)?.[0] ??
    contract.sync.cursorField;
  const raw = eventCol ? row[eventCol] : undefined;
  const ms = raw === undefined || raw === null ? NaN : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : ingestMs;
}

/** Project a source row to declared columns + metadata (drops unknown fields). */
export function projectRow(
  row: Record<string, unknown>,
  contract: SourceContract,
  manifest: ChunkManifest,
  ingestMs: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    tenant_id: manifest.tenantId,
    workspace_id: manifest.workspaceId,
    _source: contract.source,
    _chunk_id: manifest.id,
    _ingested_at: toDateTime(new Date(ingestMs).toISOString()),
    _version: versionFor(row, contract, ingestMs),
  };
  for (const [name, col] of Object.entries(contract.columns)) {
    out[name] = normalizeValue(row[name], col.type);
  }
  return out;
}

/** Load one manifest's raw chunk into ingested. */
export async function loadChunk(
  deps: { warehouse: Warehouse; raw: RawStore; now?: () => number },
  contract: SourceContract,
  manifest: ChunkManifest,
): Promise<LoadResult> {
  const body = await deps.raw.get(manifest.rawKey);
  const rows = parseJsonl(body);
  const ingestMs = (deps.now ?? Date.now)();
  const projected = rows.map((row) =>
    projectRow(row, contract, manifest, ingestMs),
  );

  await deps.warehouse.ensureTable(
    ingestedDdl(deps.warehouse.database, contract),
  );
  for (const sql of ingestedAddColumnStatements(deps.warehouse.database, contract)) {
    await deps.warehouse.command(sql);
  }
  const table = `${deps.warehouse.database}.${ingestedTableName(contract)}`;
  await deps.warehouse.insert(table, projected);
  return { table, rows: projected.length };
}

/**
 * Resolve the current contract from disk and load. Used by both the Inngest
 * workflow step and the inline fallback (when Inngest is not configured).
 */
export async function loadManifest(
  deps: LoaderDeps,
  manifest: ChunkManifest,
): Promise<LoadResult> {
  const path = deps.workspaces
    .pathsFor(manifest.workspaceId)
    .sourceContract(manifest.source);
  const contract = await readContract(path);
  if (!contract) {
    throw new Error(`no contract for source "${manifest.source}"`);
  }
  if (manifest.schemaFingerprint !== schemaFingerprint(contract)) {
    throw new Error(
      `contract drifted for ${manifest.source}/${manifest.dataset}; re-onboard`,
    );
  }
  return loadChunk(
    { warehouse: deps.warehouse, raw: deps.raw },
    contract,
    manifest,
  );
}

export interface ProcessResult {
  loaded: LoadResult;
  tables: string[];
}

/** Load a manifest into ingested, then rebuild prepared/aggregated for its dataset. */
export async function processManifest(
  deps: LoaderDeps,
  manifest: ChunkManifest,
): Promise<ProcessResult> {
  const loaded = await loadManifest(deps, manifest);
  const { tables } = await rebuildTransforms(
    deps.warehouse,
    deps.warehouse.database,
    manifest.dataset,
  );
  return { loaded, tables };
}
