import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceContract } from "./contract.js";
import { diffColumns } from "./drift.js";

const contract: SourceContract = {
  version: 1,
  source: "mock",
  dataset: "d",
  baseUrl: "http://x",
  sync: { mode: "full", endpoint: "/v1/d", pageSize: 10 },
  load: {
    target: "clickhouse",
    layer: "ingested",
    mode: "append",
    dedupe: "none",
    key: ["a"],
  },
  columns: { a: { type: "UInt64" }, b: { type: "String" } },
};

test("detects added columns (additive drift)", () => {
  const diff = diffColumns(contract, [{ name: "a" }, { name: "b" }, { name: "c" }]);
  assert.deepEqual(diff.added, ["c"]);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.drifted, true);
});

test("detects removed columns", () => {
  const diff = diffColumns(contract, [{ name: "a" }]);
  assert.deepEqual(diff.removed, ["b"]);
  assert.equal(diff.drifted, true);
});

test("no drift when columns match", () => {
  assert.equal(diffColumns(contract, [{ name: "a" }, { name: "b" }]).drifted, false);
});
