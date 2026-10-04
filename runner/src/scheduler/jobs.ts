import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { currentUser } from "../auth/current-user.js";
import type { Config } from "../config.js";
import { hydrate } from "../hydrate/hydration.js";
import { createHydrateViews } from "../hydrate/views.js";
import { rebuildInsights } from "../insights/insights.js";
import { readContract } from "../sources/contract.js";
import { telemetry } from "../telemetry/metrics.js";
import type { Warehouse } from "../warehouse/client.js";
import { rebuildTransforms } from "../warehouse/transform.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { WorkspacePaths } from "../workspace/paths.js";
import type { ScheduledJob } from "./scheduler.js";

export interface JobDeps {
  config: Config;
  warehouse: Warehouse;
  workspaces: WorkspaceManager;
}

async function contractDatasets(paths: WorkspacePaths): Promise<string[]> {
  if (!existsSync(paths.sourcesDir)) return [];
  const entries = await readdir(paths.sourcesDir, { withFileTypes: true });
  const datasets: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contract = await readContract(paths.sourceContract(entry.name));
    if (contract) datasets.push(contract.dataset);
  }
  return datasets;
}

/** Nightly materialization: rebuild silver/gold, then refresh the DuckDB cache. */
async function warehouseRefresh(deps: JobDeps): Promise<string> {
  const list = await deps.workspaces.list();
  let datasets = 0;
  let hydrated = 0;
  for (const workspace of list) {
    const paths = deps.workspaces.pathsFor(workspace.id);
    const specs = await contractDatasets(paths);
    if (specs.length === 0) continue;

    for (const dataset of specs) {
      await rebuildTransforms(deps.warehouse, deps.warehouse.database, dataset);
      datasets += 1;
    }
    const age = await freshnessSeconds(deps.warehouse, workspace.id);
    if (age !== null) telemetry().setFreshness(workspace.id, age);
    const manifest = await hydrate(
      { warehouse: deps.warehouse, paths },
      { days: 90 },
    );
    await createHydrateViews(deps.config, paths, manifest);
    hydrated += 1;
  }
  return `rebuilt ${datasets} dataset(s), hydrated ${hydrated} workspace(s)`;
}

async function insightsRefresh(deps: JobDeps): Promise<string> {
  const list = await deps.workspaces.list();
  let count = 0;
  for (const workspace of list) {
    count += await rebuildInsights(
      { warehouse: deps.warehouse },
      { tenantId: currentUser().id, workspaceId: workspace.id },
    );
  }
  return `computed ${count} insight(s) across ${list.length} workspace(s)`;
}

/** Seconds since the newest silver event for a workspace (null if unknown). */
async function freshnessSeconds(
  warehouse: Warehouse,
  workspaceId: string,
): Promise<number | null> {
  try {
    const rows = await warehouse.queryRows(
      `SELECT toUnixTimestamp(now()) - toUnixTimestamp(max(started_at)) AS age ` +
        `FROM ${warehouse.database}.silver_stream_events ` +
        `WHERE workspace_id = '${workspaceId.replace(/'/g, "")}'`,
    );
    const age = Number(rows[0]?.age);
    return Number.isFinite(age) && age >= 0 ? age : null;
  } catch {
    return null;
  }
}

export function createJobs(deps: JobDeps): ScheduledJob[] {
  return [
    {
      id: "warehouse-refresh",
      intervalMs: deps.config.SCHEDULER_REFRESH_INTERVAL_MS,
      description: "rebuild silver/gold and refresh the DuckDB hydration window",
      run: () => warehouseRefresh(deps),
    },
    {
      id: "insights",
      intervalMs: deps.config.SCHEDULER_INSIGHTS_INTERVAL_MS,
      description: "recompute gold_insights for every workspace",
      run: () => insightsRefresh(deps),
    },
  ];
}
