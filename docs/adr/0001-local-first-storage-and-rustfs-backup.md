# ADR 0001: Local-first working set, RustFS as recovery set

- Status: Accepted
- Date: 2026-09-29

## Context

Aegis is a local-first, low-cost analytical notebook. Raw uploads (JSON, CSV,
Parquet, OTEL logs, timeseries) feed a DuckDB analytical engine driven by a Pi
agent. The original design routed DuckDB reads through RustFS's S3 API using
`httpfs`.

RustFS is a local, S3-compatible object store: its objects live on the same
filesystem as the application. Reading bytes back through HTTP to reach data on
the local disk adds latency, range-request overhead, and a failure surface
without adding durability that local disk does not already have.

## Decision

Separate the **working set** from the **recovery set**.

- **Working set (query path):** raw uploads and workspace artifacts live on
  local disk. DuckDB reads local files directly. Nothing on the query path
  depends on RustFS being reachable.
- **Recovery set (durability path):** RustFS receives immutable, content-addressed
  copies asynchronously. It is used for retention, versioning, workspace
  restore, and future cloud-bucket ingestion.

Concretely:

1. An upload is written to local disk first. A content hash is computed.
2. An async job copies the object to
   `s3://aegis-backups/{workspace_id}/uploads/{sha256}.{ext}`.
3. A **backup manifest** (PocketBase `backups` + `uploads` collections, see
   ADR 0002) records `upload_id -> content_hash, s3_key, status`.
4. `restore(workspace_id)` rebuilds a workspace from the manifest and RustFS
   without any local state. This is built early even though snapshotting is
   deferred, so backups are never undated.

DuckDB never reads from RustFS in this phase. If Aegis later becomes
multi-node, RustFS is promoted to the query path then.

## Consequences

### Positive
- Query latency is local-disk latency.
- RustFS outages do not block the agent or notebook queries.
- Backups are content-addressed and immutable; de-duplication is free.
- A clear promotion path to a shared/remote object store.

### Negative / costs
- Two storage locations to reconcile; the manifest must stay consistent.
- Restore logic must be written and tested, not assumed.
- Workspace snapshots must checkpoint DuckDB (or exclude its WAL) before
  archiving.

## Alternatives considered

- **DuckDB over RustFS `httpfs` as the primary read path.** Rejected for the
  local-first phase: extra hop for same-disk data.
- **No object store at all.** Rejected: loses immutability, retention, and the
  cheap path to cloud ingestion.
- **RustFS only, no local working copy.** Rejected: no offline/low-latency
  query path, and RustFS becomes a hard dependency.
