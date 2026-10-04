import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChunkManifest } from "../types.js";
import { MemoryBroker } from "../transport/broker.js";
import { TOPICS } from "../transport/topics.js";
import { publishManifest, startChunkBridge } from "./bridge.js";

const manifest: ChunkManifest = {
  id: "chk1",
  tenantId: "t1",
  workspaceId: "w1",
  source: "twitch-mock",
  dataset: "streamers",
  contractVersion: 1,
  schemaFingerprint: "sha256:abc",
  sync: { mode: "incremental", to: "2026-01-01T00:00:00.000Z" },
  rawKey: "raw/t1/w1/twitch-mock/streamers/abc.jsonl",
  rows: 3,
  bytes: 100,
  contentHash: "abc",
  attempt: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("bridge receives manifests published to ingest.chunks, keyed by workspace", async () => {
  const broker = new MemoryBroker();
  const got: ChunkManifest[] = [];
  await startChunkBridge(broker, async (m) => {
    got.push(m);
  });
  await publishManifest(broker, manifest);

  assert.equal(got.length, 1);
  assert.equal(got[0]?.id, "chk1");
  assert.equal(got[0]?.rawKey, manifest.rawKey);
  assert.equal(broker.published[0]?.topic, TOPICS.ingestChunks);
  assert.equal(broker.published[0]?.key, "w1");
});

test("bridge ignores malformed messages instead of throwing", async () => {
  const broker = new MemoryBroker();
  const got: ChunkManifest[] = [];
  await startChunkBridge(broker, async (m) => {
    got.push(m);
  });
  await broker.publish(TOPICS.ingestChunks, "w1", "not json");
  assert.equal(got.length, 0);
});
