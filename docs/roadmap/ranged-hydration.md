# Ranged hydration (user-picked local windows)

**Status:** idea / not implemented · **Owner:** — · **Last updated:** 2026-10-11

Related: [`agent-authored-transforms.md`](./agent-authored-transforms.md) ·
[`../plex-scenario.html`](../plex-scenario.html) (the high-volume example that motivates this).

## Problem

Hydration currently exports a **fixed rolling window** per workspace:

```
POST /workspaces/:id/hydrate  { days?, asOf?, tables? }
  → window = [asOf - days, asOf]
  → monthPartitions(from, to) → hydrate/<table>/YYYY-MM.parquet
  → manifest.json (cached partitions, as-of watermark)
  → DuckDB hydrate_<table> views
```

For **high-volume sources** (e.g. a Plex TV telemetry stream) a 90-day window can be
far too much to materialize locally, and the user often only needs a specific
interval. We want: *pick a range → we load exactly that → notify → they continue.*

## Goal

Let the user (or the agent) request an **explicit date range** per dataset; materialize
only the needed partitions into local Parquet + DuckDB; report progress asynchronously
and notify on completion, without blocking the workspace.

## Non-goals

- Replacing ClickHouse as the authority — local copy only, still rebuildable.
- Querying ClickHouse (or remote Parquet) on the read path.
- Continuous/streaming sync into DuckDB.

## Current state (already built)

- **Partition-granular incremental**: closed month partitions cached & skipped; the
  open month re-exported; out-of-window partitions dropped.
- **Manifest is the authority** for what is cached, stamped `data as of T`.
- **`hydrate_<table>` views** glob the Parquet (`read_parquet('hydrate/<table>/*.parquet')`).

So this is largely a **packaging** change: explicit range + async job + notification +
finer partitions + caps.

## Design

### 1. Explicit range
- `POST /workspaces/:id/hydrate { from, to, tables?, granularity? }`.
- Keep `days`/`asOf` as sugar for a rolling window.
- Partition set comes from `monthPartitions(from, to)` (or day partitions, below).

### 2. Async job (off the request path)
Today hydration runs inside the HTTP call; a large export will outlive an HTTP timeout.
Move it to a background job:

- Disk-authoritative job record `hydrate/jobs/<id>.json`: `{ status, from, to, tables,
  granularity, progress: {done,total}, error, createdAt, updatedAt }`.
- **One hydration job per workspace** (lease/`KeyedQueue`, like agent sessions).
- Endpoints: `POST` returns `{ jobId }`; `GET …/hydrate/status`; `POST …/hydrate/:jobId/cancel`.
- Per-partition retry so a failure doesn't lose the whole range.

### 3. Notification
- Reuse the existing **SSE** pattern from agent runs: `GET …/hydrate/events` streams
  progress + a terminal event; or poll `GET …/hydrate/status`.
- UI: "Preparing 2026-01-01 → 2026-03-31 · 40%" and a **toast when done**; the user
  keeps working in the meantime.

### 4. Partition granularity
- Keep **monthly** for slow-changing facts/dimensions.
- Add **daily** partitions for high-volume datasets (a `physical.partitionGranularity:
  "month" | "day"` hint on the contract/table, defaulting to month).
- Because partitions are directory-named, DuckDB queries with a time predicate get
  **file pruning** for free — so a broader materialized range stays fast.

### 5. Caps & eviction
- Per-workspace disk budget (there is already a `QuotaService` for uploads).
- **Estimate size before export** (rows × column bytes, or a `LIMIT 0` probe); refuse
  or trim when over budget.
- **LRU eviction** of partitions, with optional explicit "pin".
- Prefer the **coarsest table** that answers the question (aggregates, not raw events).

### 6. Serving integration
- The hydrate manifest already drives views; extend it with `range` and `granularity`
  per table. Registry-driven hydration (see the transforms spec) makes new marts
  automatically hydratable.

## API sketch

```
POST /workspaces/:id/hydrate
  { "from":"2026-01-01", "to":"2026-04-01",
    "tables":["aggregated_qoe_daily"], "granularity":"day" }
  → 202 { "jobId":"..." }

GET  /workspaces/:id/hydrate/status
  → { jobId, status: "running", progress: { done: 12, total: 30 },
      from, to, tables, asOf }

GET  /workspaces/:id/hydrate/events        # SSE: progress + done/error
POST /workspaces/:id/hydrate/:jobId/cancel
```

## Data model

```
workspaces/<ws>/hydrate/manifest.json      # per table: partitions[], range, granularity, asOf
workspaces/<ws>/hydrate/jobs/<id>.json     # job status + progress (disk authority)
workspaces/<ws>/hydrate/<table>/YYYY-MM.parquet      # month granularity
workspaces/<ws>/hydrate/<table>/YYYY-MM-DD.parquet   # day granularity
```

## Correctness

- **Closed** partitions are immutable → safe to reuse across overlapping requests.
- The **open** period is always re-exported.
- Every export is stamped with an **as-of** watermark for reproducibility.
- Overlapping ranges: keep the union of partitions; evict out-of-range ones subject to
  the eviction policy.
- Idempotent: re-running a range produces the same partitions (content is a projection).

## Risks

- Long exports blocking a single workspace if the lease isn't respected.
- Disk growth from repeated ad-hoc ranges → hence caps + eviction.
- Stale open period if a user assumes "as of now".
- Partial failures → per-partition retry + resumable jobs.
- Query cost if a user hydrates far more than they query → size estimates + guidance.

## Open questions

- One window per workspace (replace) or multiple pinned windows?
- Who chooses: the user via a picker, the agent inferring from the question, or both?
- Eviction: pure LRU, or explicit pins per window?
- Granularity: a contract field, a table-registry field, or decided at request time?
- Do we ever **skip Parquet** and let DuckDB read ClickHouse-exported objects remotely?
  (Probably not — breaks local-first.)

## Milestones

1. `from`/`to` parameters (drive existing partition logic).
2. Async job + `status` endpoint (no more blocking request).
3. SSE progress + a UI range picker and completion toast.
4. Daily partitions + size estimate + caps/eviction.
5. Agent integration: infer a range from the question and request hydration.
