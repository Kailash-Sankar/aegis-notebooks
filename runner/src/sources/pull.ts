import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { runIngest } from "../ingest/gateway.js";
import { publishManifest } from "../ingest/bridge.js";
import type { RawStore } from "../raw/store.js";
import type { Broker } from "../transport/broker.js";
import { telemetry } from "../telemetry/metrics.js";
import { HttpSourceClient, type SourceClient } from "./connector.js";
import { readContract, schemaFingerprint, type SourceContract } from "./contract.js";
import { readState, writeState } from "./state.js";
import { makeSecretResolver, readCredentials } from "./secrets.js";

/**
 * Source execution helpers shared by the HTTP routes and the agent tools:
 * build an auth-aware client from a contract, pull + land a source, and list
 * the sources configured for a workspace.
 */

export interface SourcePullDeps {
  raw: RawStore;
  broker: Broker;
}

/** The subset of `WorkspacePaths` the source helpers need. */
export interface SourcePaths {
  sourcesDir: string;
  sourceContract(source: string): string;
  sourceState(source: string): string;
  sourceCredentials(source: string): string;
}

export interface SourcePullResult {
  source: string;
  chunks: number;
  rows: number;
  watermark: string | null;
  landed: Array<{ id: string; deduped: boolean }>;
}

/** Build an auth-aware client for a contract, resolving secrets from disk/env. */
export async function buildSourceClient(
  paths: SourcePaths,
  contract: SourceContract,
): Promise<SourceClient> {
  const credentials = await readCredentials(paths.sourceCredentials(contract.source));
  return new HttpSourceClient(contract.baseUrl, {
    auth: contract.auth,
    resolveSecret: makeSecretResolver(credentials),
  });
}

/** Pull + land one source, publishing claim-check manifests to the broker. */
export async function runSourcePull(
  deps: SourcePullDeps,
  paths: SourcePaths,
  args: {
    tenantId: string;
    workspaceId: string;
    source: string;
    maxChunks?: number;
  },
): Promise<SourcePullResult> {
  const contract = await readContract(paths.sourceContract(args.source));
  if (!contract) throw new Error(`no contract for source "${args.source}"`);
  const client = await buildSourceClient(paths, contract);
  const state = await readState(paths.sourceState(args.source));

  const landed: Array<{ id: string; deduped: boolean }> = [];
  const result = await runIngest(deps.raw, {
    tenantId: args.tenantId,
    workspaceId: args.workspaceId,
    contract,
    client,
    state,
    ...(args.maxChunks !== undefined ? { maxChunks: args.maxChunks } : {}),
    onManifest: async (manifest, deduped) => {
      landed.push({ id: manifest.id, deduped });
      telemetry().recordChunk(manifest.rows, deduped);
      await publishManifest(deps.broker, manifest);
    },
  });
  await writeState(paths.sourceState(args.source), result.state);

  return {
    source: args.source,
    chunks: result.chunks,
    rows: result.rows,
    watermark: result.state.watermark,
    landed,
  };
}

export interface SourceSummary {
  source: string;
  dataset: string;
  baseUrl: string;
  endpoint: string;
  syncMode: string;
  authType: string;
  fingerprint: string;
  columns: number;
  watermark: string | null;
  lastSyncAt: string | null;
  hasCredentials: boolean;
}

/** List the sources configured for a workspace (from disk contracts + state). */
export async function listSources(paths: SourcePaths): Promise<SourceSummary[]> {
  if (!existsSync(paths.sourcesDir)) return [];
  const entries = await readdir(paths.sourcesDir, { withFileTypes: true });
  const out: SourceSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contract = await readContract(paths.sourceContract(entry.name));
    if (!contract) continue;
    const state = await readState(paths.sourceState(entry.name));
    const credentials = await readCredentials(paths.sourceCredentials(entry.name));
    out.push({
      source: contract.source,
      dataset: contract.dataset,
      baseUrl: contract.baseUrl,
      endpoint: contract.sync.endpoint,
      syncMode: contract.sync.mode,
      authType: contract.auth?.type ?? "none",
      fingerprint: schemaFingerprint(contract),
      columns: Object.keys(contract.columns).length,
      watermark: state.watermark,
      lastSyncAt: state.updatedAt,
      hasCredentials: Object.keys(credentials).length > 0,
    });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}
