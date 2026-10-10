import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryWarehouse } from "../warehouse/client.js";
import { workspacePaths } from "../workspace/paths.js";
import { hydrate, monthPartitions } from "./hydration.js";
import { readManifest } from "./manifest.js";

test("monthPartitions covers [from, to)", () => {
  assert.deepEqual(
    monthPartitions("2025-12-15T00:00:00.000Z", "2026-03-15T00:00:00.000Z"),
    ["2025-12", "2026-01", "2026-02", "2026-03"],
  );
});

test("hydrate exports a window and is incremental on refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "aegis-hydrate-"));
  try {
    const paths = workspacePaths(root, "w1");
    const warehouse = new MemoryWarehouse();

    const first = await hydrate(
      { warehouse, paths },
      { asOf: "2026-03-15T00:00:00.000Z", days: 90 },
    );
    const firstExports = warehouse.exports.length;
    assert.ok(firstExports > 0);
    assert.deepEqual(
      Object.keys(first.tables.prepared_stream_events?.partitions ?? {}),
      ["2025-12", "2026-01", "2026-02", "2026-03"],
    );
    // A model with no time column exports one "all" partition.
    assert.deepEqual(
      Object.keys(first.tables.aggregated_channel_totals?.partitions ?? {}),
      ["all"],
    );
    assert.ok(await readManifest(paths.hydrateManifest));

    const second = await hydrate(
      { warehouse, paths },
      { asOf: "2026-03-15T12:00:00.000Z", days: 90 },
    );
    // Closed months are reused; only the open month per time-partitioned table
    // plus the full table are re-exported.
    assert.equal(warehouse.exports.length - firstExports, 3);
    assert.equal(
      second.tables.prepared_stream_events?.partitions["2026-02"]?.checksum,
      first.tables.prepared_stream_events?.partitions["2026-02"]?.checksum,
    );
    assert.notEqual(
      second.tables.prepared_stream_events?.partitions["2026-03"]?.checksum,
      first.tables.prepared_stream_events?.partitions["2026-03"]?.checksum,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
