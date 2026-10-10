import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContract, type SourceContract } from "./contract.js";
import { validateContractSchema } from "./contract-schema.js";

const valid: SourceContract = {
  version: 1,
  source: "twitch-mock",
  dataset: "stream_events",
  baseUrl: "http://mock-source:8099",
  sync: {
    mode: "incremental",
    endpoint: "/v1/stream_events",
    cursorField: "updated_at",
    cursorParam: "updated_since",
    pageSize: 500,
  },
  load: {
    target: "clickhouse",
    layer: "ingested",
    mode: "upsert",
    dedupe: "latest_by_key",
    key: ["event_id"],
  },
  columns: {
    event_id: { type: "String" },
    channel_id: { type: "UInt64" },
    updated_at: { type: "DateTime64(3, 'UTC')", eventTime: true },
  },
};

test("published schema accepts a valid contract", () => {
  assert.equal(validateContractSchema(valid).valid, true);
});

test("published schema rejects malformed contracts with reasons", () => {
  const badSource = validateContractSchema({ ...valid, source: "Bad Name" });
  assert.equal(badSource.valid, false);
  assert.ok(badSource.errors.length > 0);

  assert.equal(
    validateContractSchema({ ...valid, load: { ...valid.load, key: [] } }).valid,
    false,
  );
  // incremental requires a cursorField
  assert.equal(
    validateContractSchema({
      ...valid,
      sync: { mode: "incremental", endpoint: "/v1/x", pageSize: 10 },
    }).valid,
    false,
  );
});

test("parseContract and the published schema agree", () => {
  const cases: unknown[] = [
    valid,
    { ...valid, source: "Bad Name" },
    { ...valid, load: { ...valid.load, mode: "nope" } },
    { ...valid, sync: { mode: "incremental", endpoint: "/x", pageSize: 0 } },
  ];
  for (const candidate of cases) {
    const schemaValid = validateContractSchema(candidate).valid;
    let parseOk = true;
    try {
      parseContract(candidate);
    } catch {
      parseOk = false;
    }
    assert.equal(schemaValid, parseOk, JSON.stringify(candidate).slice(0, 80));
  }
});
