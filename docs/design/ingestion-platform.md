# Design: Ingestion, Warehouse & Serving Platform

- Status: **Proposed** (for review; no implementation yet)
- Date: 2026-10-03
- Extends: ADR 0001 (local-first / RustFS), ADR 0002 (disk authority / PocketBase projection)

This document specifies the batch-ingestion and analytics platform layered onto
Aegis Notebooks: a mocked OLTP source, a contract-driven ELT pipeline into
ClickHouse, event-driven and scheduled processing, windowed hydration into
DuckDB for notebooks, and a lightweight observability stack. The goal is to
cover OLTP and OLAP fundamentals end to end without over-building.

Everything below is a design decision to pressure-test, not a description of
existing code.

---

## 1. Goals and non-goals

### Goals
- Ingest data from a **mocked OLTP source** in chunks, with realistic connector
  behaviour (pagination, cursors, rate limits, drift).
- Make the agent map each source **once** into a durable **contract**.
- Land raw data immutably, transport events through a **real queue**, and load a
  **columnar warehouse** with engine-level dedupe.
- Run **scheduled** and **event-driven** jobs over the warehouse.
- **Hydrate** a windowed slice of the warehouse into DuckDB for notebooks.
- Observe the whole pipeline with bounded, low-noise telemetry.
- Learn: OLTP vs OLAP, at-least-once + idempotency, partitioning/ordering,
  medallion layering, materialization, cache invalidation, observability.

### Non-goals (explicitly deferred)
- Exactly-once streaming, Flink-style windowing.
- Multi-node / replicated ClickHouse, sharding.
- DB-per-tenant isolation, cross-region.
- Real CDC from a production Postgres.
- Orchestrators other than Inngest (Dagster/Airflow are studied later).
- SaaS observability, error tracking, LLM tracing (deferred).

---

## 2. Authority model

One authority per fact. Extended from ADR 0001/0002 for the ingestion path:

| Tier | Store | Owns | Mutable? |
|---|---|---|---|
| Raw / lake | **RustFS `raw/`** | Immutable truth of what arrived | Append-only |
| Warehouse | **ClickHouse** | Rebuildable materializations (bronze/silver/gold) | Rewritable |
| Serving cache | **DuckDB** | A window of the warehouse, per workspace | Disposable |
| Catalog | **PocketBase** | Queryable metadata projection | Projection |

**Acid test:** it must be possible to `DROP DATABASE` in ClickHouse and rebuild
it entirely from RustFS raw + the contracts. If not, the authority model is
broken.

### RustFS role change (deliberate)
ADR 0001 defined RustFS as a **recovery set only**, off the query path. This
design **promotes RustFS to the raw authority** for ingested data. It remains
**off the read/query path** — notebooks never read RustFS — but ingestion
*captures to* it and the loader *reads from* it. Upload backup behaviour is
unchanged. This is the first new ADR this design should produce.

### Principles
- **Accept vs process.** The gateway acknowledges *acceptance*, not completion.
- **Contract-first.** The agent writes a contract; deterministic code executes.
- **LLM once, deterministic forever.** Ambiguity is resolved once, then frozen.
- **Claim check.** Queues carry small pointers/manifests, never bulk payloads.
- **At-least-once.** Delivery is at-least-once; consumers must be idempotent.

---

## 3. Architecture

```
 Mock OLTP source (SQLite + generator + HTTP API)
        │  connector: cursor / updated_since / pagination / backoff
        ▼
 ┌──────────────────────────────┐
 │ INGESTION GATEWAY (runner)    │  auth · quota · validate · dedupe(hash)
 │                               │  → RustFS raw + chunk manifest → publish
 └───────┬───────────────────┬────┘
         │ raw (immutable)   │ chunk.landed (pointer only)
         ▼                   ▼
   ┌────────────┐     ┌────────────────────────┐
   │ RustFS raw │     │ Redpanda               │
   │ = AUTHORITY│     │ topic ingest.chunks    │
   │  (lake)    │     │ key = workspace_id     │
   └─────┬──────┘     └───────────┬────────────┘
         │ replay (rebuild)       │ consume (bridge)
         │                        ▼
         │              ┌───────────────────────────┐
         │              │ Inngest (control plane)   │
         │              │ durable workflows, scheds │
         │              └───────────┬───────────────┘
         │                          │ apply contract
         │                          ▼
         │              ┌───────────────────────────┐
         └─────────────▶│ ClickHouse (OLAP)         │
                        │ shared db + tenant/ws cols │
                        │ bronze → silver → gold     │
                        └───────────┬───────────────┘
                                    │ export window (Parquet)
                                    ▼
                        ┌───────────────────────────┐
                        │ Hydration → DuckDB        │
                        │ notebooks + agent         │
                        └───────────────────────────┘

 Cross-cutting: apps → OTel Collector → SigNoz
```

**Responsibility split:** RustFS = truth; Redpanda = transport; Inngest =
control; ClickHouse = compute; DuckDB = serving; PocketBase = catalog.

---

## 4. Data model and flows

### 4.1 Mock OLTP source (SQLite + HTTP API)

Storage is SQLite; a thin Node HTTP API sits in front so the connector exercises
real ingestion concerns rather than reading a file directly.

**Schema (illustrative):**

```sql
CREATE TABLE streamers (
  channel_id   INTEGER PRIMARY KEY,
  display_name TEXT    NOT NULL,
  language     TEXT,
  followers    INTEGER,
  partner      INTEGER,
  mature       INTEGER,
  created_at   TEXT,
  updated_at   TEXT    NOT NULL
);

CREATE TABLE stream_events (
  event_id      TEXT    PRIMARY KEY,
  channel_id    INTEGER NOT NULL,
  started_at    TEXT    NOT NULL,
  ended_at      TEXT,
  peak_viewers  INTEGER,
  watch_minutes INTEGER,
  updated_at    TEXT    NOT NULL
);
```

**Generator behaviour** (a loop mutating SQLite):
- insert new events continuously;
- update existing rows (`followers`, `ended_at`, …) → mutable current state;
- *back-date* `updated_at` occasionally → late-arriving rows;
- occasionally delete a row → tombstones;
- occasionally add a column → schema drift, triggers re-onboarding.

**HTTP API:**
- `GET /v1/{dataset}?updated_since={iso}&cursor={opaque}&limit={n}`
- Response: `{ "data": [...], "next_cursor": "...", "server_time": "..." }`
- Cursor is opaque (e.g. base64 of `updated_at + primary key`) for stable
  pagination while rows mutate underneath.
- Injected faults: `429` with `Retry-After`, occasional `500`.
- `sync_mode: full` datasets (no `updated_at`) are also supported.

### 4.2 Source contract

The onboarding agent produces this once per source (and again on drift). It is
the *only* place that encodes source semantics.

Location on disk (authority): `sources/{source}/contract.yaml`.

```yaml
version: 1
source: twitch-mock
dataset: streamers

sync:
  mode: incremental            # full | incremental
  endpoint: /v1/streamers
  cursor_field: updated_at     # watermark column
  cursor_param: updated_since
  page_size: 500

load:
  target: clickhouse
  layer: bronze
  mode: upsert                 # append | upsert
  dedupe: latest_by_key        # -> ReplacingMergeTree(_version)
  key: [channel_id]

columns:
  channel_id:   { type: UInt64 }
  display_name: { type: String }
  language:     { type: LowCardinality(String) }
  followers:    { type: UInt64 }
  partner:      { type: UInt8 }
  mature:       { type: UInt8 }
  updated_at:   { type: DateTime64(3), event_time: true }

quality:
  - not_null: [channel_id, display_name]
  - unique:   [channel_id]

physical:
  partition_by: toYYYYMM(updated_at)
  order_by: [channel_id]
```

Notes:
- `sync_mode` is a *source capability*, not a preference.
- `event_time` + `partition_by` + `order_by` drive the physical layout.
- `pii: true` marks columns for future masking.
- A `schema_fingerprint` (hash of the column set) is stored alongside; a change
  invalidates the contract and re-opens onboarding.

### 4.3 Ingestion gateway

Responsibilities (fast, dumb, idempotent):
1. Authenticate / resolve `tenant_id`, `workspace_id`.
2. Enforce quota (ADR 0005).
3. Validate the chunk against the contract (`schema_fingerprint`, types).
4. Dedupe by `content_hash` (same chunk seen twice → no-op).
5. Write raw immutably to RustFS; write a **chunk manifest**.
6. Publish `chunk.landed` (the manifest pointer) to Redpanda.
7. Return `202 Accepted` — acceptance, not completion.

### 4.4 Landing and the chunk manifest

**Raw path convention (RustFS):**

```
raw/{tenant_id}/{workspace_id}/{source}/{dataset}/{YYYY-MM-DD}/{chunk_id}.jsonl
manifests/{tenant_id}/{workspace_id}/{chunk_id}.json
```

**Chunk manifest** (also the queue message — claim check):

```json
{
  "id": "chk_01J...",
  "tenantId": "tnt_...",
  "workspaceId": "ws_...",
  "source": "twitch-mock",
  "dataset": "streamers",
  "contractVersion": 1,
  "schemaFingerprint": "sha256:...",
  "sync": { "mode": "incremental", "from": "2026-01-01T00:00:00Z", "to": "2026-01-02T00:00:00Z" },
  "rawKey": "raw/.../2026-01-02/chk_01J....jsonl",
  "rows": 500,
  "bytes": 123456,
  "contentHash": "sha256:...",
  "attempt": 1,
  "createdAt": "2026-01-02T00:00:05Z"
}
```

The queue never carries the payload — only this pointer. Bulk bytes stay in
RustFS.

### 4.5 Transport (Redpanda)

| Topic | Key | Partitions | Retention | Purpose |
|---|---|---|---|---|
| `ingest.chunks` | `workspace_id` | 6 | 7d | chunk-landed manifests |
| `ingest.dlq` | `workspace_id` | 3 | 30d | poison chunks after max attempts |
| `warehouse.events` | `workspace_id` | 6 | 7d | `gold.updated`, insight/refresh triggers |

- **Partition key = `workspace_id`** → per-workspace ordering; consumers scale
  up to the partition count.
- **Consumer group** `loader`; offsets committed **after** the ClickHouse insert
  succeeds → at-least-once → loader must be idempotent.
- **Replay**: rewind `ingest.chunks` offsets to reprocess; RustFS raw remains the
  system of record, the broker is a bounded replay buffer.

### 4.6 Orchestration (Inngest)

Inngest runs as a local process (`inngest dev`) or a single compose service. All
work is modelled as durable, multi-step workflows; the bridge consumer forwards
`chunk.landed` into an Inngest event.

**Workflows** (names indicative):

| Workflow | Trigger | Steps |
|---|---|---|
| `ingest/chunk.load` | event `ingest/chunk.landed` | read raw → apply contract → insert bronze → update catalog → emit `warehouse.events` |
| `warehouse/rebuild` | schedule (nightly) | silver transforms → gold aggregations → emit freshness |
| `insights/daily` | schedule (daily) | trends / anomaly detection → `gold_insights` |
| `hydration/refresh` | event or on-demand | export window → write Parquet → write manifest → swap DuckDB views |
| `retention/sweep` | schedule | expire raw / TTL housekeeping |

Rules:
- **Concurrency keyed by `workspace_id`** so one workspace cannot stampede.
- Retries with exponential backoff per step; terminal failures surface, not
  silently drop.
- Workflows are idempotent (safe to re-run); a re-run must not double-write.
- **Backfills** are a workflow invoked with an explicit chunk/partition range
  (manual in Inngest; automatic in Dagster if adopted later).

### 4.7 Warehouse (ClickHouse)

**Layout:** a single shared database `aegis`; every table carries
`tenant_id` and `workspace_id` as the leading `ORDER BY` keys. Isolation is by
predicate now; DB-per-tenant is a documented future upgrade.

**Bronze** (raw-shaped, deduped at the engine level):

```sql
CREATE TABLE IF NOT EXISTS aegis.bronze_streamers
(
  tenant_id    LowCardinality(String),
  workspace_id LowCardinality(String),
  channel_id   UInt64,
  display_name String,
  language     LowCardinality(String),
  followers    UInt64,
  partner      UInt8,
  mature       UInt8,
  updated_at   DateTime64(3, 'UTC'),
  _source      LowCardinality(String),
  _chunk_id    String,
  _ingested_at DateTime64(3, 'UTC'),
  _version     UInt64
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(updated_at)
ORDER BY (tenant_id, workspace_id, channel_id);
```

- `ReplacingMergeTree(_version)` keeps the highest `_version` per `ORDER BY` key
  → engine-level dedupe/upsert.
- `PARTITION BY toYYYYMM(event_time)` → partition pruning for range queries.
- Queries must filter on `tenant_id`/`workspace_id` (enforced by a query builder
  / views as defence in depth).

**Silver / gold:** normalised / modelled tables and derived aggregates
(`MergeTree` or `AggregatingMergeTree` + materialized views), same leading keys.
`gold_insights` holds background-computed results.

Physical-layout lessons to exercise: partition pruning, sparse primary index via
`ORDER BY`, `ReplacingMergeTree` dedupe, part count / merge health, TTL.

### 4.8 Hydration (ClickHouse → Parquet → DuckDB)

Notebooks never query ClickHouse live. A hydration job exports a window to
Parquet; DuckDB reads the Parquet.

- **Default window:** rolling **90 days**, overridable per notebook.
- **Consistency:** hydrate **as of a watermark** `T` (all tables filtered to
  `≤ T`); stamp the notebook "data as of `T`". Enables reproducibility / time
  travel.
- **Incremental:** partition-granular. New partition → append its Parquet file;
  changed partition → **replace** its file(s); unchanged → skip. Never blind
  append, because late rows / upserts rewrite old partitions.
- **Append-only vs mutable:** immutable fact tables append cleanly; mutable
  dimension/current-state tables require replacement (the SCD problem).

**Hydration manifest:**

```json
{
  "tenantId": "tnt_...",
  "workspaceId": "ws_...",
  "asOf": "2026-01-02T00:00:00Z",
  "window": { "start": "2025-10-04T00:00:00Z", "end": "2026-01-02T00:00:00Z", "days": 90 },
  "tables": {
    "gold_revenue_daily": {
      "watermark": "2026-01-02T00:00:00Z",
      "files": [
        { "path": "hydrate/.../2025-11.parquet", "partition": "2025-11", "rows": 4321, "checksum": "sha256:..." }
      ]
    }
  },
  "createdAt": "2026-01-02T00:00:12Z"
}
```

The manifest is the authority for what is cached; DuckDB views glob the Parquet.

### 4.9 Serving (DuckDB)

- DuckDB holds the hydrated Parquet + views; the agent and widgets query it.
- Read-only, serialized per workspace (existing `ducklock`).
- Refreshing a notebook = advancing the hydration watermark, not re-querying CH.

---

## 5. Workspace directory contract (extension)

```
/workspaces/{workspace_id}/
├── workspace.json
├── workspace.duckdb
├── data/                          # ad-hoc uploads (existing)
├── sources/                       # NEW
│   └── {source}/
│       ├── contract.yaml          # agent-authored, authority
│       ├── contract.json          # compiled form (types, fingerprint)
│       └── state.json             # cursor/watermark, last chunk, lag
├── hydrate/                       # NEW
│   └── {asOf}/manifest.json + *.parquet
├── memory/                        # existing
└── notebooks/{notebook_id}/       # existing
```

Bulk raw bytes live in RustFS, not here. Local `sources/` holds only small
control files.

---

## 6. Observability

**Principle:** metrics are the backbone, traces show pipeline flow, logs are
errors-only. Enforced in the OTel Collector, not in the apps.

**Stack:** OTel SDK → **OTel Collector** → self-hosted **SigNoz**, sharing the
warehouse ClickHouse instance in a **separate database**, under its own CH user
and settings profile (memory/priority caps) so telemetry cannot be starved by,
or starve, the warehouse. Splitting to a dedicated instance is the documented
upgrade when contention appears.

**Noise control:**
- Logs: structured JSON to stdout; forward only `WARN`/`ERROR`.
- Traces: tail sampling — keep all errors + all slow, ~10% of normal.
- Never log per row/chunk; emit counters/histograms.
- **TTL** in SigNoz ClickHouse: traces 7d, logs 7d, metrics 30–90d.

**Primary metrics (golden signals per component):**

| Component | Signals |
|---|---|
| Connector | pages/min, pull latency, errors, rate-limit hits |
| Gateway | chunks in, bytes, dedupe hits, validation failures |
| Redpanda | **consumer lag**, produce/consume rate, DLQ count |
| Loader / CH | insert rate, insert errors, query p95, **part count** |
| Inngest | runs, failures, step duration |
| Runner HTTP | request rate, error rate, p95 latency |
| **End-to-end** | **freshness** (source watermark → queryable in CH), hydration duration |

**Traces:** one per chunk (connector → gateway → consumer → loader → CH) and one
per notebook query/hydration.

**The one dashboard that matters:** freshness + consumer lag.

---

## 7. Decisions (ADR-style)

1. **Raw is authority; warehouse is rebuildable.** RustFS `raw/` is the
   immutable truth; ClickHouse is droppable and rebuildable from raw + contracts.
   *Why:* preserves ADR 0002's "disk is authority" under a new datastore.
2. **Claim check transport.** Redpanda carries manifests/pointers, not payloads.
   *Why:* keeps the broker light; RustFS owns bytes.
3. **Redpanda for transport, Inngest for control.** Orthogonal concerns
   (delivery vs lifecycle). *Why:* teaches both without overlap; keeps stack TS.
4. **Shared CH DB with `tenant_id` + `workspace_id` leading keys.** *Why:*
   isolation-by-predicate is the transferable multi-tenant lesson; DB-per-tenant
   deferred.
5. **Contract-first ingestion; LLM once.** Agent authors `contract.yaml`;
   deterministic loader executes. *Why:* reproducibility, cost, testability.
6. **At-least-once + idempotent consumers.** Offsets committed after write;
   `ReplacingMergeTree` + contract keys dedupe. *Why:* honest distributed
   semantics.
7. **Windowed, as-of hydration; partition-granular incremental.** *Why:*
   reproducibility, cache-correctness, and the cache-invalidation lesson.
8. **Metrics-first, low-noise observability.** OTel + Collector + SigNoz,
   errors-only logs, sampled traces, TTL caps. *Why:* visibility without bloat.
9. **Definitions as files, runtime state in a store.** Job definitions on disk;
   run history append-only + projected to PocketBase. *Why:* matches Airflow's
   defs-as-code/metadata-DB split; keeps disk authority.
10. **SigNoz shares the warehouse ClickHouse, isolated by database.** Separate
    database + a dedicated CH user/profile with caps. *Why:* fewest resources;
    demonstrates namespace isolation; the shared-fate risk is capped and the
    split to a dedicated instance is the documented upgrade.
11. **Inngest runs as a compose service.** *Why:* consistency with the existing
    infra (Redpanda/CH/PB/RustFS), service DNS instead of host/container
    plumbing, dev/prod parity. *Revisit* if workflow iteration becomes the
    bottleneck (run locally).
12. **Failed chunks go to a DLQ and surface; nothing blocks.** Transient errors
    retry with backoff; terminal (contract/validation/drift) errors DLQ
    immediately. *Why:* avoids head-of-line blocking; keeps gaps loud via the
    freshness metric and a UI count; DLQ is durable for replay.
13. **Backfills are operator-only initially.** Expose an endpoint/CLI seam
    ("reprocess range"); no user-facing action yet. *Why:* backfills are a
    correctness problem first; avoids expensive accidental recomputes.
14. **Contracts are disk-authoritative with a PocketBase metadata projection.**
    Body in `sources/{source}/contract.yaml`; only pointers/status projected to
    PB. *Why:* the ADR 0002 invariant; enables cheap source/drift listing.

---

## 8. Roadmap

- **Phase 1 — Event-driven ingestion.** Mock source → connector → gateway →
  RustFS raw + manifest → Redpanda → Inngest → loader → CH bronze. No scheduler.
- **Phase 2 — Warehouse.** Shared CH DB; engines/partitions/ordering;
  bronze→silver→gold.
- **Phase 3 — Transforms + scheduling.** Silver/gold as durable steps; nightly
  jobs; event-triggered workflows; manual range backfills.
- **Phase 4 — Hydration.** CH→Parquet→DuckDB; 90d default; as-of watermark;
  partition-granular incremental.
- **Phase 5 — Background insights.** Periodic trends/anomalies → `gold_insights`.
- **Cross-cutting — Observability** from Phase 1.

---

## 9. Resolved questions

All former open questions are decided and folded into §7 above. Recorded here
with the trigger that would revisit them:

| Question | Decision | Revisit when |
|---|---|---|
| SigNoz ClickHouse | **Separate DB on the same CH instance**, own user/profile caps | Contention appears, or to demo control-plane / data-plane fate separation |
| Inngest runtime | **Compose service** | Workflow iteration becomes the bottleneck |
| Failed chunks | **DLQ + surface**, never block; classify transient vs terminal | Add automatic DLQ replay once contracts self-heal |
| Backfill UX | **Operator-only** endpoint/CLI seam | Mechanics stable + clear product case + per-workspace concurrency limits |
| Contract storage | **Disk authority + PB metadata projection** | Never (body); projection fields may grow |

Two items are worth promoting to standalone ADRs before Phase 1: **RustFS as
raw authority** (changes ADR 0001) and **claim-check transport**.
