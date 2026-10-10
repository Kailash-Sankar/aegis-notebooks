import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryWarehouse } from "./client.js";
import { rebuildTransforms, transformsFor } from "./transform.js";

test("stream_events yields prepared + two aggregated models", () => {
  const steps = transformsFor("aegis", "stream_events");
  assert.deepEqual(
    steps.map((s) => s.table),
    ["prepared_stream_events", "aggregated_stream_daily", "aggregated_channel_totals"],
  );
  const sql = steps.flatMap((s) => s.statements).join("\n");
  assert.match(sql, /ingested_stream_events FINAL/);
  assert.match(sql, /TRUNCATE TABLE IF EXISTS aegis\.prepared_stream_events/);
  assert.match(sql, /GROUP BY tenant_id, workspace_id, day, channel_id/);
  assert.match(sql, /dateDiff\('minute'/);
});

test("unknown datasets have no transforms", () => {
  assert.deepEqual(transformsFor("aegis", "nope"), []);
});

test("rebuildTransforms runs every statement in order", async () => {
  const warehouse = new MemoryWarehouse();
  const result = await rebuildTransforms(warehouse, "aegis", "stream_events");
  assert.deepEqual(result.tables, [
    "prepared_stream_events",
    "aggregated_stream_daily",
    "aggregated_channel_totals",
  ]);
  // 3 models x (create + truncate + insert)
  assert.equal(warehouse.commands.length, 9);
  assert.ok(
    warehouse.commands[0]?.startsWith(
      "CREATE TABLE IF NOT EXISTS aegis.prepared_stream_events",
    ),
  );
  assert.ok(warehouse.commands[1]?.startsWith("TRUNCATE TABLE IF EXISTS"));
  assert.ok(
    warehouse.commands[2]?.startsWith("INSERT INTO aegis.prepared_stream_events"),
  );
});

test("rejects an unsafe database identifier", () => {
  assert.throws(
    () => transformsFor("aegis; DROP DATABASE x", "stream_events"),
    /unsafe identifier/,
  );
});
