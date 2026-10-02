import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRawStore } from "../raw/store.js";
import {
  ChunkValidationError,
  landChunk,
  runIngest,
  validateChunk,
} from "./gateway.js";
import type { SourceContract } from "../sources/contract.js";
import type { SourceClient } from "../sources/connector.js";

const contract: SourceContract = {
  version: 1,
  source: "twitch-mock",
  dataset: "streamers",
  baseUrl: "http://mock.local",
  sync: {
    mode: "incremental",
    endpoint: "/v1/streamers",
    cursorField: "updated_at",
    pageSize: 2,
  },
  load: {
    target: "clickhouse",
    layer: "bronze",
    mode: "upsert",
    dedupe: "latest_by_key",
    key: ["channel_id"],
  },
  columns: {
    channel_id: { type: "UInt64" },
    updated_at: { type: "DateTime64(3)", eventTime: true },
  },
  quality: { notNull: ["channel_id"] },
};

const row = (id: number): Record<string, unknown> => ({
  channel_id: id,
  updated_at: "2026-01-01T00:00:00.000Z",
});

test("lands a chunk as content-addressed raw + a manifest", async () => {
  const raw = new MemoryRawStore();
  const { manifest, deduped } = await landChunk(raw, {
    tenantId: "t1",
    workspaceId: "w1",
    contract,
    rows: [row(1), row(2)],
    sync: { mode: "incremental", to: "2026-01-01T00:00:00.000Z" },
  });

  assert.equal(deduped, false);
  assert.equal(manifest.rows, 2);
  assert.match(
    manifest.rawKey,
    /^raw\/t1\/w1\/twitch-mock\/streamers\/[0-9a-f]{64}\.jsonl$/,
  );
  assert.equal((await raw.list("raw/")).length, 1);
  assert.equal((await raw.list("manifests/")).length, 1);

  const body = Buffer.from(await raw.get(manifest.rawKey)).toString("utf8");
  assert.equal(body.trim().split("\n").length, 2);
});

test("re-landing identical bytes dedupes the raw object", async () => {
  const raw = new MemoryRawStore();
  const input = {
    tenantId: "t1",
    workspaceId: "w1",
    contract,
    rows: [row(1)],
    sync: { mode: "incremental" as const },
  };
  const first = await landChunk(raw, input);
  const second = await landChunk(raw, input);
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal((await raw.list("raw/")).length, 1);
  // Each landing still records a manifest (audit trail).
  assert.equal((await raw.list("manifests/")).length, 2);
});

test("rejects chunks that violate key/not-null rules", async () => {
  const raw = new MemoryRawStore();
  await assert.rejects(
    () =>
      landChunk(raw, {
        tenantId: "t1",
        workspaceId: "w1",
        contract,
        rows: [{ updated_at: "2026-01-01T00:00:00.000Z" }],
        sync: { mode: "incremental" },
      }),
    ChunkValidationError,
  );
  await assert.rejects(
    () =>
      landChunk(raw, {
        tenantId: "t1",
        workspaceId: "w1",
        contract,
        rows: [],
        sync: { mode: "incremental" },
      }),
    ChunkValidationError,
  );
  assert.doesNotThrow(() => validateChunk(contract, [row(1)]));
});

test("runIngest pulls and lands every chunk, publishing manifests", async () => {
  const raw = new MemoryRawStore();
  const client: SourceClient = {
    async fetchPage(args) {
      const first = !args.cursor;
      return {
        data: first
          ? [row(1), row(2)]
          : [row(3)],
        nextCursor: first ? "c1" : null,
        serverTime: "2026-01-02T00:00:00.000Z",
      };
    },
  };
  const published: Array<{ id: string; deduped: boolean }> = [];
  const result = await runIngest(raw, {
    tenantId: "t1",
    workspaceId: "w1",
    contract,
    client,
    onManifest: async (manifest, deduped) => {
      published.push({ id: manifest.id, deduped });
    },
  });

  assert.equal(result.chunks, 2);
  assert.equal(result.rows, 3);
  assert.equal(published.length, 2);
  assert.equal((await raw.list("raw/")).length, 2);
  assert.equal(result.state.watermark, "2026-01-01T00:00:00.000Z");
});
