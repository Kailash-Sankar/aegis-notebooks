import { test } from "node:test";
import assert from "node:assert/strict";
import { discover, profileColumns } from "./discover.js";

test("profiles column types and uniqueness", () => {
  const rows = [
    { id: 1, name: "a", ts: "2026-01-01T00:00:00.000Z", score: 1.5, active: true },
    { id: 2, name: "b", ts: "2026-01-02T00:00:00.000Z", score: 2.5, active: false },
  ];
  const cols = Object.fromEntries(profileColumns(rows).map((c) => [c.name, c]));
  assert.equal(cols.id?.baseType, "UInt64");
  assert.equal(cols.id?.unique, true);
  assert.equal(cols.name?.baseType, "String");
  assert.match(cols.ts?.baseType ?? "", /^DateTime64/);
  assert.equal(cols.score?.baseType, "Float64");
  assert.equal(cols.active?.baseType, "Bool");
});

test("nulls wrap the type in Nullable", () => {
  const rows = [{ a: 1, b: null }, { a: 2, b: null }];
  const cols = Object.fromEntries(profileColumns(rows).map((c) => [c.name, c]));
  assert.equal(cols.b?.type, "Nullable(String)");
  assert.equal(cols.b?.nullRatio, 1);
});

test("discovers a draft with key, cursor and eventTime", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    event_id: `e${i}`,
    channel_id: 1,
    started_at: `2026-01-0${i + 1}T00:00:00.000Z`,
    watch_minutes: i * 10,
  }));
  const d = discover({
    source: "mock",
    dataset: "events",
    baseUrl: "http://x",
    endpoint: "/v1/events",
    rows,
  });
  assert.deepEqual(d.candidateKeys, ["event_id"]);
  assert.ok(d.candidateCursorFields.includes("started_at"));
  assert.equal(d.draft.sync.mode, "incremental");
  assert.equal(d.draft.sync.cursorField, "started_at");
  assert.equal(d.draft.columns.started_at?.eventTime, true);
  assert.equal(d.draft.load.mode, "upsert");
  assert.deepEqual(d.draft.load.key, ["event_id"]);
});

test("warns and falls back to full/append when no key or timestamp", () => {
  const rows = [{ a: 1 }, { a: 1 }];
  const d = discover({
    source: "mock",
    dataset: "d",
    baseUrl: "http://x",
    endpoint: "/v1/d",
    rows,
  });
  assert.ok(d.warnings.length >= 1);
  assert.equal(d.draft.sync.mode, "full");
  assert.equal(d.draft.load.dedupe, "none");
});
