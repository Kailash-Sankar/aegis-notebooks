import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "./paths.js";
import { buildWarehouseContext } from "./warehouse-context.js";

test("buildWarehouseContext summarizes the hydration manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "aegis-wh-"));
  try {
    const paths = workspacePaths(root, "w1");
    await mkdir(paths.hydrateDir, { recursive: true });
    await writeFile(
      paths.hydrateManifest,
      JSON.stringify({
        workspaceId: "w1",
        asOf: "2026-10-04T00:00:00Z",
        window: { from: "2026-07-06T00:00:00Z", to: "2026-10-04T00:00:00Z", days: 90 },
        tables: {
          aggregated_stream_daily: {
            view: "hydrate_aggregated_stream_daily",
            watermark: "2026-10-04T00:00:00Z",
            partitions: { "2026-10": {} },
          },
        },
        createdAt: "2026-10-04T00:00:00Z",
      }),
      "utf8",
    );
    const context = await buildWarehouseContext(paths);
    assert.ok(context);
    assert.match(context, /hydrate_aggregated_stream_daily/);
    assert.match(context, /last 90 days/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildWarehouseContext is null without a manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "aegis-wh-"));
  try {
    assert.equal(await buildWarehouseContext(workspacePaths(root, "w1")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
