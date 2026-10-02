import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A source contract is the agent-authored description of how to pull and shape
 * one dataset (design §4.2). It is the single place that encodes source
 * semantics; deterministic code (the connector + loader) executes it. Disk is
 * the authority (ADR 0002); see `sources/{source}/contract.json`.
 */

export type SyncMode = "full" | "incremental";
export type LoadMode = "append" | "upsert";
export type DedupeMode = "latest_by_key" | "none";

export interface ContractColumn {
  type: string;
  /** Marks the event/watermark column used for incremental sync + partitions. */
  eventTime?: boolean;
  pii?: boolean;
}

export interface SourceContract {
  version: 1;
  source: string;
  dataset: string;
  /** Base URL of the source HTTP API (the "connection"). */
  baseUrl: string;
  sync: {
    mode: SyncMode;
    /** Request path, e.g. `/v1/streamers`. */
    endpoint: string;
    /** Watermark column (incremental only). */
    cursorField?: string;
    /** Query param carrying the watermark, e.g. `updated_since`. */
    cursorParam?: string;
    pageSize: number;
  };
  load: {
    target: "clickhouse";
    layer: "bronze";
    mode: LoadMode;
    dedupe: DedupeMode;
    key: string[];
  };
  columns: Record<string, ContractColumn>;
  quality?: { notNull?: string[]; unique?: string[] };
  physical?: { partitionBy?: string; orderBy?: string[] };
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

const SOURCE_RE = /^[a-z0-9][a-z0-9_-]*$/;

function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ContractError(`${where} must be an object`);
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ContractError(`${where} must be a non-empty string`);
  }
  return v;
}

function asPositiveInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ContractError(`${where} must be a positive integer`);
  }
  return v;
}

/** Validate + narrow an untrusted object (e.g. parsed JSON) to a contract. */
export function parseContract(raw: unknown): SourceContract {
  const root = asRecord(raw, "contract");
  const source = asString(root.source, "source");
  if (!SOURCE_RE.test(source)) {
    throw new ContractError(
      `source "${source}" must match ${SOURCE_RE} (safe path segment)`,
    );
  }
  const sync = asRecord(root.sync, "sync");
  const mode = asString(sync.mode, "sync.mode");
  if (mode !== "full" && mode !== "incremental") {
    throw new ContractError(`sync.mode must be "full" or "incremental"`);
  }
  const load = asRecord(root.load, "load");
  const loadMode = asString(load.mode, "load.mode");
  if (loadMode !== "append" && loadMode !== "upsert") {
    throw new ContractError(`load.mode must be "append" or "upsert"`);
  }
  const dedupe = asString(load.dedupe, "load.dedupe");
  if (dedupe !== "latest_by_key" && dedupe !== "none") {
    throw new ContractError(`load.dedupe must be "latest_by_key" or "none"`);
  }
  const key = load.key;
  if (!Array.isArray(key) || key.length === 0 || !key.every((k) => typeof k === "string")) {
    throw new ContractError("load.key must be a non-empty array of strings");
  }

  const columnsRaw = asRecord(root.columns, "columns");
  const columns: Record<string, ContractColumn> = {};
  for (const [name, colRaw] of Object.entries(columnsRaw)) {
    const col = asRecord(colRaw, `columns.${name}`);
    columns[name] = {
      type: asString(col.type, `columns.${name}.type`),
      ...(col.eventTime === true ? { eventTime: true } : {}),
      ...(col.pii === true ? { pii: true } : {}),
    };
  }
  if (Object.keys(columns).length === 0) {
    throw new ContractError("columns must declare at least one column");
  }

  const syncOut: SourceContract["sync"] = {
    mode,
    endpoint: asString(sync.endpoint, "sync.endpoint"),
    pageSize: asPositiveInt(sync.pageSize, "sync.pageSize"),
    ...(sync.cursorField === undefined
      ? {}
      : { cursorField: asString(sync.cursorField, "sync.cursorField") }),
    ...(sync.cursorParam === undefined
      ? {}
      : { cursorParam: asString(sync.cursorParam, "sync.cursorParam") }),
  };
  if (mode === "incremental" && !syncOut.cursorField) {
    throw new ContractError("incremental sync requires sync.cursorField");
  }

  return {
    version: 1,
    source,
    dataset: asString(root.dataset, "dataset"),
    baseUrl: asString(root.baseUrl, "baseUrl"),
    sync: syncOut,
    load: {
      target: "clickhouse",
      layer: "bronze",
      mode: loadMode,
      dedupe,
      key: key as string[],
    },
    columns,
    ...(root.quality === undefined
      ? {}
      : { quality: parseQuality(root.quality) }),
    ...(root.physical === undefined
      ? {}
      : { physical: parsePhysical(root.physical) }),
  };
}

function parseQuality(raw: unknown): SourceContract["quality"] {
  const q = asRecord(raw, "quality");
  const out: NonNullable<SourceContract["quality"]> = {};
  if (q.notNull !== undefined) {
    if (!Array.isArray(q.notNull)) throw new ContractError("quality.notNull must be an array");
    out.notNull = q.notNull.map((v, i) => asString(v, `quality.notNull[${i}]`));
  }
  if (q.unique !== undefined) {
    if (!Array.isArray(q.unique)) throw new ContractError("quality.unique must be an array");
    out.unique = q.unique.map((v, i) => asString(v, `quality.unique[${i}]`));
  }
  return out;
}

function parsePhysical(raw: unknown): SourceContract["physical"] {
  const p = asRecord(raw, "physical");
  const out: NonNullable<SourceContract["physical"]> = {};
  if (p.partitionBy !== undefined) {
    out.partitionBy = asString(p.partitionBy, "physical.partitionBy");
  }
  if (p.orderBy !== undefined) {
    if (!Array.isArray(p.orderBy)) throw new ContractError("physical.orderBy must be an array");
    out.orderBy = p.orderBy.map((v, i) => asString(v, `physical.orderBy[${i}]`));
  }
  return out;
}

/**
 * A stable hash of the contract's *shape* (columns + key). A change means the
 * source drifted and the contract must be re-derived before loading.
 */
export function schemaFingerprint(contract: SourceContract): string {
  const cols = Object.entries(contract.columns)
    .map(([name, col]) => [name, col.type] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const shape = {
    columns: cols,
    key: [...contract.load.key].sort(),
  };
  return "sha256:" + createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

/** Read a contract from disk, or null when absent. Throws on malformed JSON. */
export async function readContract(path: string): Promise<SourceContract | null> {
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  return parseContract(JSON.parse(text));
}

/** Atomically write a contract (temp file + rename). */
export async function writeContract(
  path: string,
  contract: SourceContract,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(contract, null, 2), "utf8");
  await rename(tmp, path);
}
