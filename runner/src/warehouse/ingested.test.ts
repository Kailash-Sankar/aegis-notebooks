import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertColumnType,
  assertIdentifier,
  ingestedAddColumnStatements,
  ingestedDdl,
  ingestedTableName,
} from "./ingested.js";
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
    layer: "ingested",
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
  const ddl = ingestedDdl("aegis", contract);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS aegis\.ingested_streamers/);
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
  const ddl = ingestedDdl("aegis", append);
  assert.match(ddl, /ENGINE = MergeTree\(\)/);
  assert.match(ddl, /PARTITION BY toYYYYMM\(_ingested_at\)/);
});

test("emits additive ALTER statements for schema evolution", () => {
  const stmts = ingestedAddColumnStatements("aegis", contract);
  assert.ok(
    stmts.some((s) =>
      s.startsWith(
        "ALTER TABLE aegis.ingested_streamers ADD COLUMN IF NOT EXISTS channel_id UInt64",
      ),
    ),
  );
  assert.equal(stmts.length, Object.keys(contract.columns).length);
});

test("accepts parameterized and nested column types", () => {
  for (const t of [
    "UInt64",
    "LowCardinality(String)",
    "DateTime64(3, 'UTC')",
    "Nullable(DateTime64(3, 'UTC'))",
    "Decimal(18, 4)",
  ]) {
    assert.equal(assertColumnType(t), t);
  }
  assert.throws(() => assertColumnType("Int64 -- comment"), /unsafe column type/);
});

test("rejects unsafe identifiers and column types (no SQL injection)", () => {
  assert.throws(() => assertIdentifier("bad; DROP TABLE x"), /unsafe identifier/);
  assert.throws(() => assertColumnType("UInt64; DROP TABLE x"), /unsafe column type/);
  assert.throws(
    () => ingestedDdl("aegis", { ...contract, dataset: "x;drop" }),
    /unsafe identifier/,
  );
  assert.equal(ingestedTableName(contract), "ingested_streamers");
});
