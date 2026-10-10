import { assertIdentifier } from "./ingested.js";
import type { Warehouse } from "./client.js";

/**
 * Prepared/aggregated transforms (design §4.7). Plain, hand-written SQL — no dbt — so
 * the mechanics are visible: a **full rebuild** per run (TRUNCATE + INSERT ...
 * SELECT). That is idempotent and simple; a production system would make these
 * incremental (watermarks / materialized views). dbt is a deliberate later
 * comparison.
 *
 * Tables use plain `MergeTree`: rows are already deduped/aggregated by the
 * SELECT, and the whole table is replaced each run.
 */

export interface TransformStep {
  table: string;
  /** DDL, then rebuild statements, executed in order. */
  statements: string[];
}

/** `TRUNCATE` + `INSERT ... SELECT` — a full, idempotent rebuild. */
function rebuildStep(
  database: string,
  table: string,
  ddl: string,
  insertSelect: string,
): TransformStep {
  const db = assertIdentifier(database);
  const name = assertIdentifier(table);
  return {
    table: name,
    statements: [
      ddl,
      `TRUNCATE TABLE IF EXISTS ${db}.${name}`,
      `INSERT INTO ${db}.${name} ${insertSelect}`,
    ],
  };
}

function streamEventTransforms(db: string): TransformStep[] {
  const prepared = rebuildStep(
    db,
    "prepared_stream_events",
    `CREATE TABLE IF NOT EXISTS ${db}.prepared_stream_events (
       tenant_id LowCardinality(String),
       workspace_id LowCardinality(String),
       event_id String,
       channel_id UInt64,
       started_at DateTime64(3, 'UTC'),
       ended_at Nullable(DateTime64(3, 'UTC')),
       peak_viewers UInt64,
       watch_minutes UInt64,
       duration_minutes UInt64,
       updated_at DateTime64(3, 'UTC'),
       _version UInt64
     )
     ENGINE = MergeTree
     PARTITION BY toYYYYMM(updated_at)
     ORDER BY (tenant_id, workspace_id, event_id)`,
    `SELECT
       tenant_id,
       workspace_id,
       event_id,
       channel_id,
       started_at,
       ended_at,
       peak_viewers,
       watch_minutes,
       toUInt64(greatest(0, dateDiff('minute', started_at, coalesce(ended_at, updated_at)))) AS duration_minutes,
       updated_at,
       _version
     FROM ${db}.ingested_stream_events FINAL`,
  );

  const daily = rebuildStep(
    db,
    "aggregated_stream_daily",
    `CREATE TABLE IF NOT EXISTS ${db}.aggregated_stream_daily (
       tenant_id LowCardinality(String),
       workspace_id LowCardinality(String),
       day Date,
       channel_id UInt64,
       events UInt64,
       watch_minutes UInt64,
       peak_viewers_max UInt64,
       peak_viewers_avg Float64,
       avg_duration_minutes Float64
     )
     ENGINE = MergeTree
     ORDER BY (tenant_id, workspace_id, day, channel_id)`,
    `SELECT
       tenant_id,
       workspace_id,
       toDate(started_at) AS day,
       channel_id,
       count() AS events,
       sum(watch_minutes) AS watch_minutes,
       max(peak_viewers) AS peak_viewers_max,
       avg(peak_viewers) AS peak_viewers_avg,
       avg(duration_minutes) AS avg_duration_minutes
     FROM ${db}.prepared_stream_events
     GROUP BY tenant_id, workspace_id, day, channel_id`,
  );

  const totals = rebuildStep(
    db,
    "aggregated_channel_totals",
    `CREATE TABLE IF NOT EXISTS ${db}.aggregated_channel_totals (
       tenant_id LowCardinality(String),
       workspace_id LowCardinality(String),
       channel_id UInt64,
       events UInt64,
       watch_minutes UInt64,
       peak_viewers_max UInt64,
       first_seen DateTime64(3, 'UTC'),
       last_seen DateTime64(3, 'UTC')
     )
     ENGINE = MergeTree
     ORDER BY (tenant_id, workspace_id, channel_id)`,
    `SELECT
       tenant_id,
       workspace_id,
       channel_id,
       count() AS events,
       sum(watch_minutes) AS watch_minutes,
       max(peak_viewers) AS peak_viewers_max,
       min(started_at) AS first_seen,
       max(started_at) AS last_seen
     FROM ${db}.prepared_stream_events
     GROUP BY tenant_id, workspace_id, channel_id`,
  );

  return [prepared, daily, totals];
}

function streamerTransforms(db: string): TransformStep[] {
  return [
    rebuildStep(
      db,
      "prepared_streamers",
      `CREATE TABLE IF NOT EXISTS ${db}.prepared_streamers (
         tenant_id LowCardinality(String),
         workspace_id LowCardinality(String),
         channel_id UInt64,
         display_name String,
         language LowCardinality(String),
         followers UInt64,
         partner UInt8,
         mature UInt8,
         updated_at DateTime64(3, 'UTC'),
         _version UInt64
       )
       ENGINE = MergeTree
       PARTITION BY toYYYYMM(updated_at)
       ORDER BY (tenant_id, workspace_id, channel_id)`,
      `SELECT
         tenant_id,
         workspace_id,
         channel_id,
         display_name,
         language,
         followers,
         partner,
         mature,
         updated_at,
         _version
       FROM ${db}.ingested_streamers FINAL`,
    ),
  ];
}

/** Transform steps for a dataset. Unknown datasets are a no-op. */
export function transformsFor(database: string, dataset: string): TransformStep[] {
  const db = assertIdentifier(database);
  switch (dataset) {
    case "stream_events":
      return streamEventTransforms(db);
    case "streamers":
      return streamerTransforms(db);
    default:
      return [];
  }
}

/** Run every transform for a dataset, in dependency order. */
export async function rebuildTransforms(
  warehouse: Warehouse,
  database: string,
  dataset: string,
): Promise<{ tables: string[] }> {
  const steps = transformsFor(database, dataset);
  for (const step of steps) {
    for (const sql of step.statements) {
      await warehouse.command(sql);
    }
  }
  return { tables: steps.map((s) => s.table) };
}
