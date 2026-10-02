# ADR 0007: RustFS raw is the lake authority

- Status: Proposed
- Date: 2026-10-03
- Amends: [ADR 0001](0001-local-first-storage-and-rustfs-backup.md)

## Context

ADR 0001 made RustFS a **recovery set only**, explicitly off the query path,
with local disk as the working set. The ingestion platform
([design](../design/ingestion-platform.md)) introduces externally-ingested data
that must be captured **immutably** before any transformation, so the warehouse
(ClickHouse) can be dropped and rebuilt from source. We need to say where the
authoritative copy of that raw data lives.

## Decision

Ingested raw data is written immutably to RustFS under `raw/...`, and **RustFS
is the authority for it**.

- The gateway writes each chunk to RustFS **before** acknowledging acceptance.
- ClickHouse is a **rebuildable projection**: dropping its database and replaying
  from RustFS raw + the contracts must reproduce it.
- DuckDB remains a **disposable serving cache**; notebooks never read RustFS.
- The query path is unchanged (local disk / DuckDB). RustFS is on the
  **ingestion write path** and the **load/rebuild read path**, not the query path.
- RustFS's original recovery role (async backup of uploads) is unchanged.

This amends ADR 0001's "recovery set only" framing: RustFS is still off the query
path, but it is now also the durable raw authority for ingested data.

## Consequences

### Positive
- One immutable authority; the warehouse is provably rebuildable.
- Replay and backfill read from raw rather than re-hitting the source.
- Content-addressed raw enables free de-duplication.

### Negative / costs
- Load/rebuild depends on RustFS availability (it is on the *ingestion* path now,
  though still not on the query path).
- Reference integrity must be maintained between manifests and objects
  ("pointer exists, object missing").
- Two storage tiers (raw in RustFS, working set on disk) to reason about.

## Alternatives considered

- **Keep raw only on local disk (`data/`).** Rejected: not durable or immutable
  across a machine loss, so ClickHouse could not be rebuilt.
- **Make ClickHouse the authority.** Rejected: breaks ADR 0002's disk-authority
  rule and the drop-and-rebuild property.
- **Carry raw bytes in the queue instead of RustFS.** Rejected: see ADR 0008.
