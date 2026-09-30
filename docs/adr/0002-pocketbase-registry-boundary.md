# ADR 0002: PocketBase is a registry, not a content store

- Status: Accepted
- Date: 2026-09-29

## Context

The system has two obvious places to keep state: PocketBase (embedded SQLite)
and the workspace directory on disk. Allowing both to write the same facts
creates drift and reconciliation bugs.

We need a crisp ownership rule for metadata (workspaces, notebooks, uploads,
backups, widget specs) versus content (memory, chat history, generated assets,
DuckDB files).

## Decision

**PocketBase is the queryable index/control plane. The workspace directory is
the content/working plane.**

- PocketBase stores small, queryable rows: pointers, hashes, status, config.
- The workspace directory stores all bulk content: `chat_history.json`,
  `execution.log`, `generated_assets/`, memory markdown, and `workspace.duckdb`.

### Ownership rule
**Disk owns existence. PocketBase is a projection.**

- The runner upserts PocketBase rows after filesystem operations complete.
- On startup the runner **reconciles**: it scans disk and repairs stale or
  missing registry rows.
- If disk and PocketBase disagree about whether an entity exists, **disk wins**.
- Content (memory text, transcripts) is never stored in PocketBase.

### Collections

| collection     | key fields (beyond id)                                                        |
|----------------|-------------------------------------------------------------------------------|
| `workspaces`   | name, path, owner_id, status, created_at                                      |
| `notebooks`    | workspace_id, title, owner_id, last_active                                    |
| `uploads`      | workspace_id, filename, bytes, content_hash, s3_key, backup_status, created_at|
| `backups`      | workspace_id, kind (`upload`/`snapshot`), s3_key, size, created_at            |
| `widget_specs` | notebook_id, type (`component`/`artifact`), spec (json), position, updated_at |

## Consequences

### Positive
- One authority per fact; no bidirectional sync.
- List/filter/search UIs are cheap SQL on PocketBase.
- Backups and content stay independent: a PocketBase reset does not lose data,
  and a disk scan can rebuild the registry.

### Negative / costs
- Requires a reconciliation routine and a documented conflict rule.
- Every write path must remember to update the projection.
- Some duplication (path, size) between disk and registry.

## Alternatives considered

- **All metadata as JSON files on disk.** Rejected: no queries, slow list views,
  and harder multi-tenant filters later.
- **PocketBase as the source of truth for existence.** Rejected: content lives
  on disk, so disk is the natural authority; the DB would go stale on crash.
