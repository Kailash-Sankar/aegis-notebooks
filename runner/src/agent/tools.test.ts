import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { NullRegistry } from "../registry/pocketbase.js";
import { createAnalyticsTools, type ToolContext } from "./tools.js";

async function makeContext(): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "aegis-tools-"));
  await mkdir(join(root, "memory"), { recursive: true });
  return {
    workspaceId: "w",
    notebookId: "",
    workspaceRoot: root,
    duckdbPath: join(root, "workspace.duckdb"),
    assetsDir: join(root, "memory"),
    config: loadConfig({}),
    registry: new NullRegistry(),
  };
}

test("suggest_analysis serializes concurrent writes into valid, deduped JSON", async () => {
  const ctx = await makeContext();
  const tool = createAnalyticsTools(ctx).find((t) => t.name === "suggest_analysis")!;
  assert.ok(tool);

  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      tool.execute(`call-${i}`, { title: "Same title", prompt: "build it" }, undefined, undefined, ctx as never),
    ),
  );

  const raw = await readFile(join(ctx.workspaceRoot, "memory", "suggested_analyses.json"), "utf8");
  const parsed = JSON.parse(raw) as unknown[];
  assert.equal(parsed.length, 1, "deduped to one entry");
});

test("suggest_analysis records distinct titles", async () => {
  const ctx = await makeContext();
  const tool = createAnalyticsTools(ctx).find((t) => t.name === "suggest_analysis")!;
  await Promise.all(
    ["A", "B", "C"].map((title, i) =>
      tool.execute(`c-${i}`, { title, prompt: "x" }, undefined, undefined, ctx as never),
    ),
  );
  const parsed = JSON.parse(
    await readFile(join(ctx.workspaceRoot, "memory", "suggested_analyses.json"), "utf8"),
  ) as unknown[];
  assert.equal(parsed.length, 3);
});
