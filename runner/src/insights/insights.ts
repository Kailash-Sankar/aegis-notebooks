import { assertIdentifier } from "../warehouse/ingested.js";
import type { Warehouse } from "../warehouse/client.js";

/**
 * Background insights (design §4.6, Phase 5): periodic, deterministic SQL over
 * prepared that writes headline findings into `aggregated_insights`. The notebook reads
 * them; no LLM is involved (insights are facts, not prose).
 */

export interface InsightDeps {
  warehouse: Warehouse;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

function literal(value: string): string {
  if (!ID_RE.test(value)) throw new Error(`unsafe id: ${value}`);
  return `'${value}'`;
}

function aggregatedInsightsDdl(db: string): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${db}.aggregated_insights (` +
    `tenant_id LowCardinality(String), ` +
    `workspace_id LowCardinality(String), ` +
    `insight_id String, ` +
    `kind LowCardinality(String), ` +
    `channel_id UInt64, ` +
    `metric LowCardinality(String), ` +
    `value Float64, ` +
    `headline String, ` +
    `as_of DateTime64(3, 'UTC'), ` +
    `computed_at DateTime64(3, 'UTC')` +
    `) ENGINE = MergeTree ORDER BY (tenant_id, workspace_id, kind, insight_id)`
  );
}

async function tableExists(
  warehouse: Warehouse,
  db: string,
  table: string,
): Promise<boolean> {
  const rows = await warehouse.queryRows(
    `SELECT count() AS n FROM system.tables ` +
      `WHERE database = ${literal(db)} AND name = ${literal(table)}`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

function insertStatements(db: string, tenant: string, workspace: string): string[] {
  const t = literal(tenant);
  const w = literal(workspace);
  const selectCols = (insightId: string, kind: string, metric: string, value: string, headline: string) =>
    `SELECT ${t} AS tenant_id, ${w} AS workspace_id, ${insightId} AS insight_id, ` +
    `${kind} AS kind, {CHANNEL} AS channel_id, ${metric} AS metric, ${value} AS value, ` +
    `${headline} AS headline, now64(3) AS as_of, now64(3) AS computed_at `;

  return [
    // Top channel by watch minutes today.
    (
      `INSERT INTO ${db}.aggregated_insights ` +
      selectCols(
        `concat('top_channel_', formatDateTime(today(), '%Y-%m-%d'))`,
        `'top_channel'`,
        `'watch_minutes'`,
        `toFloat64(sum(watch_minutes))`,
        `concat('Top channel ', toString(channel_id), ' by watch minutes')`,
      ).replace("{CHANNEL}", "channel_id") +
      `FROM ${db}.prepared_stream_events WHERE workspace_id = ${w} AND toDate(started_at) = today() ` +
      `GROUP BY channel_id ORDER BY sum(watch_minutes) DESC LIMIT 1`
    ),
    // Total watch minutes today.
    (
      `INSERT INTO ${db}.aggregated_insights ` +
      selectCols(
        `'total_watch_today'`,
        `'total'`,
        `'watch_minutes'`,
        `toFloat64(sum(watch_minutes))`,
        `'Total watch minutes today'`,
      ).replace("{CHANNEL}", "toUInt64(0)") +
      `FROM ${db}.prepared_stream_events WHERE workspace_id = ${w} AND toDate(started_at) = today()`
    ),
    // Peak-viewer anomalies (max > 2x average) today.
    (
      `INSERT INTO ${db}.aggregated_insights ` +
      selectCols(
        `concat('peak_spike_', toString(channel_id))`,
        `'anomaly'`,
        `'peak_viewers'`,
        `toFloat64(max(peak_viewers))`,
        `concat('Peak spike on channel ', toString(channel_id))`,
      ).replace("{CHANNEL}", "channel_id") +
      `FROM ${db}.prepared_stream_events WHERE workspace_id = ${w} AND toDate(started_at) = today() ` +
      `GROUP BY channel_id HAVING max(peak_viewers) > 2 * avg(peak_viewers) AND avg(peak_viewers) > 0 ` +
      `ORDER BY max(peak_viewers) DESC LIMIT 5`
    ),
  ];
}

export interface RebuildInsightsArgs {
  tenantId: string;
  workspaceId: string;
}

/** Recompute a workspace's insights (delete + insert). Returns the row count. */
export async function rebuildInsights(
  deps: InsightDeps,
  args: RebuildInsightsArgs,
): Promise<number> {
  const db = assertIdentifier(deps.warehouse.database);
  const w = literal(args.workspaceId);
  await deps.warehouse.command(aggregatedInsightsDdl(db));

  if (!(await tableExists(deps.warehouse, db, "prepared_stream_events"))) {
    return 0;
  }

  // Lightweight, synchronous delete scoped to this workspace.
  await deps.warehouse.command(
    `DELETE FROM ${db}.aggregated_insights WHERE workspace_id = ${w}`,
  );
  for (const sql of insertStatements(db, args.tenantId, args.workspaceId)) {
    await deps.warehouse.command(sql);
  }

  const rows = await deps.warehouse.queryRows(
    `SELECT count() AS n FROM ${db}.aggregated_insights WHERE workspace_id = ${w}`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function listInsights(
  deps: InsightDeps,
  workspaceId: string,
): Promise<Array<Record<string, unknown>>> {
  const db = assertIdentifier(deps.warehouse.database);
  if (!(await tableExists(deps.warehouse, db, "aggregated_insights"))) return [];
  return deps.warehouse.queryRows(
    `SELECT kind, channel_id, metric, value, headline, toString(as_of) AS as_of ` +
      `FROM ${db}.aggregated_insights WHERE workspace_id = ${literal(workspaceId)} ` +
      `ORDER BY value DESC`,
  );
}
