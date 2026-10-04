import type { ChunkManifest } from "../types.js";
import type { Broker } from "../transport/broker.js";
import { CONSUMER_GROUPS, TOPICS } from "../transport/topics.js";

/**
 * The chunk bridge (design §4.5): publish landed chunk manifests to the broker,
 * and consume them on the other side.
 *
 * Today the consumer handler just logs; slice 4 replaces it with an Inngest
 * event that starts the load workflow. Keying by `workspaceId` keeps a
 * workspace's chunks ordered within one partition.
 */

export type ChunkHandler = (manifest: ChunkManifest) => Promise<void>;

/** Publish one manifest as a claim check (pointer only; ADR 0008). */
export async function publishManifest(
  broker: Broker,
  manifest: ChunkManifest,
): Promise<void> {
  await broker.publish(
    TOPICS.ingestChunks,
    manifest.workspaceId,
    JSON.stringify(manifest),
  );
}

/** Subscribe to `ingest.chunks` and invoke `onChunk` per manifest. */
export async function startChunkBridge(
  broker: Broker,
  onChunk: ChunkHandler,
): Promise<void> {
  await broker.subscribe(
    TOPICS.ingestChunks,
    CONSUMER_GROUPS.chunkBridge,
    async (message) => {
      let manifest: ChunkManifest;
      try {
        manifest = JSON.parse(message.value) as ChunkManifest;
      } catch {
        // A malformed message is poison: drop it here (DLQ routing is a later
        // slice, once failure classification is wired).
        return;
      }
      await onChunk(manifest);
    },
  );
}
