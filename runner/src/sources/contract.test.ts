import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContractError,
  parseContract,
  readContract,
  schemaFingerprint,
  writeContract,
  type SourceContract,
} from "./contract.js";

const valid: SourceContract = {
  version: 1,
  source: "twitch-mock",
  dataset: "streamers",
  baseUrl: "http://mock.local",
  sync: {
    mode: "incremental",
    endpoint: "/v1/streamers",
    cursorField: "updated_at",
    cursorParam: "updated_since",
    pageSize: 200,
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
    language: { type: "LowCardinality(String)" },
    updated_at: { type: "DateTime64(3)", eventTime: true },
  },
};

test("parses a valid contract", () => {
  const parsed = parseContract(valid);
  assert.equal(parsed.source, "twitch-mock");
  assert.equal(parsed.sync.pageSize, 200);
  assert.equal(parsed.columns.updated_at?.eventTime, true);
});

test("rejects malformed contracts", () => {
  assert.throws(
    () => parseContract({ ...valid, sync: { ...valid.sync, mode: "nope" } }),
    ContractError,
  );
  assert.throws(
    () => parseContract({ ...valid, source: "../escape" }),
    ContractError,
  );
  assert.throws(
    () => parseContract({ ...valid, load: { ...valid.load, key: [] } }),
    ContractError,
  );
  // incremental requires a cursor field
  assert.throws(
    () =>
      parseContract({
        ...valid,
        sync: {
          mode: "incremental",
          endpoint: "/v1/x",
          pageSize: 10,
        },
      }),
    ContractError,
  );
});

test("fingerprint is order-independent and type-sensitive", () => {
  const reordered: SourceContract = {
    ...valid,
    columns: {
      updated_at: { type: "DateTime64(3)", eventTime: true },
      language: { type: "LowCardinality(String)" },
      channel_id: { type: "UInt64" },
    },
  };
  assert.equal(schemaFingerprint(valid), schemaFingerprint(reordered));

  const changed: SourceContract = {
    ...valid,
    columns: { ...valid.columns, language: { type: "String" } },
  };
  assert.notEqual(schemaFingerprint(valid), schemaFingerprint(changed));
});

test("round-trips a contract through disk atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aegis-contract-"));
  try {
    const path = join(dir, "sources", "twitch-mock", "contract.json");
    await writeContract(path, valid);
    const back = await readContract(path);
    assert.ok(back);
    assert.equal(back.source, valid.source);
    assert.equal(schemaFingerprint(back), schemaFingerprint(valid));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
