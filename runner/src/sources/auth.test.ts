import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContract } from "./contract.js";

const base = {
  version: 1,
  source: "twitch",
  dataset: "stream_events",
  baseUrl: "http://x",
  sync: {
    mode: "incremental",
    endpoint: "/v1/x",
    cursorField: "updated_at",
    pageSize: 10,
  },
  load: {
    target: "clickhouse",
    layer: "ingested",
    mode: "upsert",
    dedupe: "latest_by_key",
    key: ["id"],
  },
  columns: {
    id: { type: "String" },
    updated_at: { type: "DateTime64(3)", eventTime: true },
  },
};

test("parses each auth scheme", () => {
  assert.deepEqual(parseContract({ ...base, auth: { type: "none" } }).auth, {
    type: "none",
  });
  assert.deepEqual(
    parseContract({ ...base, auth: { type: "bearer", secretRef: "T" } }).auth,
    { type: "bearer", secretRef: "T" },
  );
  assert.deepEqual(
    parseContract({
      ...base,
      auth: { type: "header", header: "x-api-key", secretRef: "T" },
    }).auth,
    { type: "header", header: "x-api-key", secretRef: "T" },
  );
  assert.deepEqual(
    parseContract({
      ...base,
      auth: { type: "query", param: "api_key", secretRef: "T" },
    }).auth,
    { type: "query", param: "api_key", secretRef: "T" },
  );
  assert.deepEqual(
    parseContract({
      ...base,
      auth: { type: "basic", usernameRef: "U", passwordRef: "P" },
    }).auth,
    { type: "basic", usernameRef: "U", passwordRef: "P" },
  );
});

test("rejects an unknown auth type and missing fields", () => {
  assert.throws(
    () => parseContract({ ...base, auth: { type: "oauth" } }),
    /not supported/,
  );
  assert.throws(
    () => parseContract({ ...base, auth: { type: "bearer" } }),
    /auth\.secretRef/,
  );
});

test("a contract without auth carries no auth field", () => {
  assert.equal(parseContract(base).auth, undefined);
});
