import { test } from "node:test";
import assert from "node:assert/strict";
import { assertColumnType, assertIdentifier, bronzeDdl, bronzeTableName } from "./bronze.js";
import type { SourceContract } from "../sources/contract.js";

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

test("generates ReplacingMergeTree DDL with partition + order by", () => {
  const ddl = bronzeDdl("aegis", contract);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS aegis\.bronze_streamers/);
  assert.match(ddl, /ReplacingMergeTree\(_version\)/);
  assert.match(ddl, /PARTITION BY toYYYYMM\(updated_at\)/);
  assert.match(ddl, /ORDER BY \(tenant_id, workspace_id, channel_id\)/);
  assert.match(ddl, /_version UInt64/);
  assert.match(ddl, /_chunk_id String/);
});

test("append contracts use MergeTree and fall back to ingest-time partitioning", () => {
  const append: SourceContract = {
    ...contract,
    load: { ...contract.load, mode: "append", dedupe: "none" },
    columns: {
      channel_id: { type: "UInt64" },
      updated_at: { type: "DateTime64(3)" },
    },
  };
  const ddl = bronzeDdl("aegis", append);
  assert.match(ddl, /ENGINE = MergeTree\(\)/);
  assert.match(ddl, /PARTITION BY toYYYYMM\(_ingested_at\)/);
});

test("rejects unsafe identifiers and column types (no SQL injection)", () => {
  assert.throws(() => assertIdentifier("bad; DROP TABLE x"), /unsafe identifier/);
  assert.throws(() => assertColumnType("UInt64; DROP TABLE x"), /unsafe column type/);
  assert.throws(
    () => bronzeDdl("aegis", { ...contract, dataset: "x;drop" }),
    /unsafe identifier/,
  );
  assert.equal(bronzeTableName(contract), "bronze_streamers");
});
