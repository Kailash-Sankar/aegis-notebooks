import { Inngest } from "inngest";
import type { ChunkManifest } from "../types.js";
import type { LoaderDeps } from "../warehouse/loader.js";
import { loadManifest } from "../warehouse/loader.js";

/**
 * Inngest workflows: the control plane (design §4.6). The first function loads
 * a landed chunk into bronze. The bridge sends `ingest/chunk.landed`; this
 * workflow runs the durable, retryable, per-workspace-serialized load.
 */

export const INGEST_EVENT = "ingest/chunk.landed";

export interface IngestWorkflowOptions {
  baseUrl?: string;
  eventKey?: string;
}

export function createIngestWorkflows(
  deps: LoaderDeps,
  options: IngestWorkflowOptions = {},
) {
  const inngest = new Inngest({
    id: "aegis-runner",
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.eventKey ? { eventKey: options.eventKey } : {}),
  });

  const loadChunkFn = inngest.createFunction(
    {
      id: "ingest-chunk-load",
      // Serialize per workspace: one workspace cannot stampede the warehouse.
      concurrency: { key: "event.data.workspaceId", limit: 1 },
    },
    { event: INGEST_EVENT },
    async ({ event, step }) => {
      const manifest = event.data as unknown as ChunkManifest;
      return step.run("load-bronze", () => loadManifest(deps, manifest));
    },
  );

  return { inngest, functions: [loadChunkFn] };
}
