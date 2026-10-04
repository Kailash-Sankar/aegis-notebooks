import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRawStore } from "../raw/store.js";
import type { SourceContract } from "../sources/contract.js";
import type { ChunkManifest } from "../types.js";
import { MemoryWarehouse } from "./client.js";
import { loadChunk, parseJsonl, projectRow } from "./loader.js";

const contract: SourceContract = {
  version: 1,
  source: "twitch-mock",
  dataset: "streamers",
  baseUrl: "http://mock.local",
  sync: {
    mode: "incremental",
    endpoint: "/v1/streamers",
    cursorField: "updated_at",
    pageSize: 100,
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
    followers: { type: "UInt64" },
    updated_at: { type: "DateTime64(3, 'UTC')", eventTime: true },
  },
};

const manifest: ChunkManifest = {
  id: "chk1",
  tenantId: "t1",
  workspaceId: "w1",
  source: "twitch-mock",
  dataset: "streamers",
  contractVersion: 1,
  schemaFingerprint: "sha256:x",
  sync: { mode: "incremental" },
  rawKey: "raw/t1/w1/twitch-mock/streamers/abc.jsonl",
  rows: 2,
  bytes: 10,
  contentHash: "abc",
  attempt: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("loads raw JSONL into bronze with projected columns + metadata", async () => {
  const raw = new MemoryRawStore();
  const sourceRows = [
    { channel_id: 1, followers: 100, updated_at: "2026-01-01T00:00:00.000Z", extra: "drop me" },
    { channel_id: 2, followers: 200, updated_at: "2026-01-02T00:00:00.000Z" },
  ];
  await raw.put(
    manifest.rawKey,
    Buffer.from(sourceRows.map((r) => JSON.stringify(r)).join("\n") + "\n"),
  );
  const warehouse = new MemoryWarehouse();

  const result = await loadChunk(
    { warehouse, raw, now: () => 1_700_000_000_000 },
    contract,
    manifest,
  );

  assert.equal(result.table, "aegis.bronze_streamers");
  assert.equal(result.rows, 2);
  assert.equal(warehouse.ddl.length, 1);

  const inserted = warehouse.rows("aegis.bronze_streamers");
  assert.equal(inserted.length, 2);
  const first = inserted[0]!;
  assert.equal(first.tenant_id, "t1");
  assert.equal(first.workspace_id, "w1");
  assert.equal(first._source, "twitch-mock");
  assert.equal(first._chunk_id, "chk1");
  assert.equal(first.channel_id, 1);
  assert.equal(first.updated_at, "2026-01-01 00:00:00.000");
  // Unknown source fields are dropped (not in the contract).
  assert.equal(first.extra, undefined);
  // _version is derived from the event-time column, not ingest time.
  assert.equal(first._version, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(first._ingested_at, "2023-11-14 22:13:20.000");
});

test("parseJsonl tolerates blank lines", () => {
  const rows = parseJsonl(Buffer.from('{"a":1}\n\n{"a":2}\n'));
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
});

test("projectRow normalizes numbers and falls back to ingest time for _version", () => {
  const row = projectRow(
    { channel_id: "7", followers: "42", updated_at: null },
    contract,
    manifest,
    1234,
  );
  assert.equal(row.channel_id, 7);
  assert.equal(row.followers, 42);
  assert.equal(row.updated_at, null);
  assert.equal(row._version, 1234);
});
