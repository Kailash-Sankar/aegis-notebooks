import { createHash } from "node:crypto";
import { newId } from "../ids.js";
import type { RawStore } from "../raw/store.js";
import type { ChunkManifest } from "../types.js";
import type { SourceContract } from "../sources/contract.js";
import { schemaFingerprint } from "../sources/contract.js";
import type { SourceClient } from "../sources/connector.js";
import { pullSource } from "../sources/connector.js";
import type { ConnectorState } from "../sources/state.js";

/**
 * The ingestion gateway (design §4.3). It is fast and dumb: validate, dedupe,
 * land raw immutably, emit a manifest. It acknowledges *acceptance*, never
 * completion. Bulk bytes go to the raw store (ADR 0007); the manifest is the
 * claim-check that later travels the queue (ADR 0008).
 */

/** A terminal chunk error: do not retry, send to the DLQ. */
export class ChunkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkValidationError";
  }
}

export interface LandChunkInput {
  tenantId: string;
  workspaceId: string;
  contract: SourceContract;
  rows: Array<Record<string, unknown>>;
  sync: { mode: string; from?: string; to?: string };
  attempt?: number;
}

export interface LandChunkResult {
  manifest: ChunkManifest;
  /** True when identical bytes were already in the lake (no-op write). */
  deduped: boolean;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/** Validate a chunk against the contract's key + not-null rules. */
export function validateChunk(
  contract: SourceContract,
  rows: Array<Record<string, unknown>>,
): void {
  if (rows.length === 0) {
    throw new ChunkValidationError("chunk is empty");
  }
  const required = new Set<string>([
    ...contract.load.key,
    ...(contract.quality?.notNull ?? []),
  ]);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    for (const col of required) {
      if (isBlank(row[col])) {
        throw new ChunkValidationError(
          `row ${i} is missing required column "${col}"`,
        );
      }
    }
  }
}

function serializeJsonl(rows: Array<Record<string, unknown>>): Buffer {
  return Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/**
 * Land one chunk: validate → content-address → write immutable raw → write the
 * manifest. Idempotent: identical bytes map to the same key and are not
 * rewritten.
 */
export async function landChunk(
  raw: RawStore,
  input: LandChunkInput,
): Promise<LandChunkResult> {
  validateChunk(input.contract, input.rows);

  const body = serializeJsonl(input.rows);
  const contentHash = createHash("sha256").update(body).digest("hex");
  const { tenantId, workspaceId, contract } = input;
  const rawKey =
    `raw/${tenantId}/${workspaceId}/${contract.source}/${contract.dataset}/` +
    `${contentHash}.jsonl`;

  const deduped = await raw.exists(rawKey);
  if (!deduped) await raw.put(rawKey, body);

  const createdAt = new Date().toISOString();
  const manifest: ChunkManifest = {
    id: newId(),
    tenantId,
    workspaceId,
    source: contract.source,
    dataset: contract.dataset,
    contractVersion: contract.version,
    schemaFingerprint: schemaFingerprint(contract),
    sync: input.sync,
    rawKey,
    rows: input.rows.length,
    bytes: body.byteLength,
    contentHash,
    attempt: input.attempt ?? 1,
    createdAt,
  };
  await raw.put(
    `manifests/${tenantId}/${workspaceId}/${manifest.id}.json`,
    Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
  );

  return { manifest, deduped };
}

export interface RunIngestArgs {
  tenantId: string;
  workspaceId: string;
  contract: SourceContract;
  client: SourceClient;
  state?: ConnectorState | null;
  maxChunks?: number;
  /** Called per landed chunk — the seam where the manifest is published. */
  onManifest?: (manifest: ChunkManifest, deduped: boolean) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export interface RunIngestResult {
  manifests: ChunkManifest[];
  state: ConnectorState;
  chunks: number;
  rows: number;
}

/** Pull from a source and land every available chunk. */
export async function runIngest(
  raw: RawStore,
  args: RunIngestArgs,
): Promise<RunIngestResult> {
  const manifests: ChunkManifest[] = [];
  const result = await pullSource({
    client: args.client,
    contract: args.contract,
    state: args.state,
    ...(args.maxChunks !== undefined ? { maxChunks: args.maxChunks } : {}),
    ...(args.sleep ? { sleep: args.sleep } : {}),
    ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
    onChunk: async (chunk) => {
      const { manifest, deduped } = await landChunk(raw, {
        tenantId: args.tenantId,
        workspaceId: args.workspaceId,
        contract: args.contract,
        rows: chunk.rows,
        sync: chunk.sync,
      });
      manifests.push(manifest);
      if (args.onManifest) await args.onManifest(manifest, deduped);
    },
  });
  return {
    manifests,
    state: result.state,
    chunks: result.chunks,
    rows: result.rows,
  };
}
