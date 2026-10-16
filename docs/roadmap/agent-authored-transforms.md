# Agent-authored warehouse transforms (`write_transform`)

**Status:** idea / not implemented · **Owner:** — · **Last updated:** 2026-10-11

A worked example that motivates this spec lives in
[`docs/plex-scenario.html`](../plex-scenario.html).

## Problem

The platform has a sharp, intentional split:

- **Ingested (bronze) is generic** — `ingestedDdl(contract)` generates the table
  from the contract, so *any* source shape lands with zero hand-written DDL.
- **Prepared/aggregated (silver/gold) are bespoke** — `transformsFor(dataset)` is a
  `switch` that returns hand-written SQL, and unknown datasets return `[]`.

So connecting a new source (e.g. a Plex server, a TV telemetry stream) gets you to
bronze automatically, but the **modeled** layers require a developer to write SQL.
Yet the agent is the component that already *understands the domain* — it wrote
`memory/onboarding_context.md` describing what the columns mean. It should be able
to turn that understanding into transforms.

## Goal

Let the agent **author, validate, and persist** warehouse transform SQL for a
workspace, so a connected source can be modelled into prepared/aggregated tables
without code changes.

## Non-goals

- Replacing dbt/Dagster/Airflow. No new orchestrator; reuse the existing scheduler +
  Inngest.
- Auto-generating transforms with no review. The agent proposes; the user confirms.
- Letting the agent run arbitrary or destructive SQL on the shared warehouse.
- Cross-workspace sharing of models (starts per-workspace).

## Design sketch

### Artifact

Transforms are **disk authority**, like contracts:

```
workspaces/<ws>/transforms/<layer>/<table>.sql      # the model body (a SELECT)
workspaces/<ws>/transforms/index.json               # registry: name, layer, table,
                                                    #   dependsOn, eventTimeColumn,
                                                    #   fingerprint, updatedAt
```

- `layer` ∈ `prepared | aggregated`.
- A model body is a single `SELECT` that produces the target table's columns; the
  runner wraps it in the idempotent `TRUNCATE` + `INSERT ... SELECT` pattern
  (same as today's `rebuildStep`).

### Tool surface

| Tool | Purpose |
|---|---|
| `list_transforms` | Show stored models, their layer/table, dependencies, fingerprint. |
| `preview_transform` | Dry-run: `EXPLAIN` + `SELECT ... LIMIT 50` to sanity-check output. |
| `write_transform` | Validate + persist a model (`dataset`, `layer`, `table`, `sql`, `dependsOn`, `eventTimeColumn`). |
| `apply_transforms` | Execute the workspace's models in dependency order (idempotent). |

`write_transform` should require the agent to present the model and get user
confirmation before persisting (mirrors `save_context`).

### Execution

- A generic `applyTransforms(workspaceId)` runs every stored model in dependency
  order: `TRUNCATE TABLE IF EXISTS t` then `INSERT INTO t <model SELECT>`.
- Idempotent by construction (full rebuild). On high-volume sources this is the
  known cost; later we can add incremental models.
- Triggered by the `warehouse-refresh` scheduler job, and optionally debounced after
  an ingest.

### Serving integration

- Hydration currently reads a fixed `HYDRATE_TABLES` list. It becomes **registry-driven**:
  any aggregated/prepared table produced by a model is a candidate for the local
  DuckDB window (`hydrate_<table>`), with its `eventTimeColumn` from the registry.

### Safety

- Model SQL may **read** `ingested_*`, `prepared_*`, `aggregated_*` and **write only**
  to `prepared_*` / `aggregated_*` (the runner wraps the write; the model is a SELECT).
- Reject DDL/DML keywords (`DROP`, `DELETE`, `ALTER`, `INSERT`, `;`-chained statements).
- Validate identifiers and referenced columns against the contract(s).
- Cap rows/bytes and require `preview_transform` output to be reviewed.

## Validation

- Referenced columns must exist in the relevant contract / ingested table.
- Output must be deterministic and match the declared table columns.
- Idempotency test: applying twice yields identical row counts.

## Risks

- **Hallucinated logic** → human confirmation + preview.
- **Cost/latency** on large event streams (full rebuilds).
- **Schema drift**: a contract change invalidates dependent models; store the
  contract fingerprint and flag models as stale when it changes.
- **Security**: keep the source grant read-only; never execute agent SQL verbatim as
  a privileged command outside the TRUNCATE+INSERT wrapper.

## Open questions

- Per-workspace models only, or a shared library for common datasets?
- Should models run per-chunk (current behaviour, wasteful) or on a schedule only?
- One table per model, or multi-step pipelines with explicit dependencies?
- Do we also let the agent author **insight** SQL, or keep insights a separate feed?
- How to version transformers alongside the contract fingerprint?

## Milestones

1. Storage + registry + `write_transform` (persist only; no execution).
2. Generic executor (`apply_transforms`) + schedule integration.
3. Registry-driven hydration.
4. Agent instructions for modelling (facts vs dimensions, grain, idempotent rebuilds)
   + preview/confirm flow.
5. Drift-triggered regeneration.
