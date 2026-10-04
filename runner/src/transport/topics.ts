/**
 * Topic + consumer-group names (design §4.5). Kept in one place so producers,
 * consumers, and infra config agree.
 *
 * - partition key is `workspace_id` so a workspace's events stay ordered and a
 *   consumer can scale up to the partition count.
 * - the broker is transport, not the system of record: raw bytes live in
 *   RustFS (ADR 0007), messages carry claim-check manifests (ADR 0008).
 */
export const TOPICS = {
  /** Chunk-landed manifests (claim checks) from the gateway. */
  ingestChunks: "ingest.chunks",
  /** Poison chunks after max attempts. */
  ingestDlq: "ingest.dlq",
  /** Warehouse lifecycle events (`gold.updated`, refresh triggers). */
  warehouseEvents: "warehouse.events",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

export const CONSUMER_GROUPS = {
  chunkBridge: "chunk-bridge",
} as const;
