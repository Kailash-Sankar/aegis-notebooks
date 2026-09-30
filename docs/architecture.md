# Aegis Notebooks — Architecture

Local-first analytical notebooks: upload data, let a Pi agent **onboard** it
(profile the data, create DuckDB views, write shared context), then open
notebooks that chat over the data and build live dashboards.

## Principles

1. **Local-first.** The working set lives on local disk; nothing on the query
   path needs a network service.
2. **One authority per fact.** Disk owns existence; PocketBase is a projection.
3. **Containers are the boundary.** Model-generated shell commands run inside a
   container, not on the host.
4. **Caps over subsystems.** Guard resource use before building retrieval.
5. **Context is a contract.** `onboarding_context.md` is confirmed, durable
   workspace memory — not a transcript or a list of guesses.

## Lifecycle

```
Workspace (global)                       Notebooks (analysis units)
  data/         uploads                    chat_history.json
  memory/       context (confirmed)        generated_assets/
  workspace.duckdb  views                  widget_specs (live charts)

1. Create workspace
2. Upload data sources
3. Onboard (workspace-scoped chat): agent profiles data, asks questions,
   then save_context commits memory → notebooks unlock
4. Create notebooks; each has its own chat + canvas, all share context/data
```

## Components

| component        | responsibility                                            | does not do                    |
|------------------|-----------------------------------------------------------|--------------------------------|
| React frontend   | workspace view, notebook canvas, chat                     | run agents, touch disk         |
| PocketBase       | registry: workspaces, uploads, backups, widget specs      | store content or memory        |
| RustFS           | immutable backup/recovery set, future cloud ingestion     | serve the query path           |
| Workspace runner | orchestrates workspaces, Pi sessions, DuckDB, ingestion   | render UI                      |
| Pi agent         | onboarding, SQL, context, widget generation               | run outside the container      |
| DuckDB           | analytical SQL over local files                           | read from RustFS (this phase)  |

Frontend: React 19 + Vite + the [Astryx](https://github.com/facebook/astryx)
design system (Recharts for widget charts).

## Data flow

```
upload
  -> local disk (working set)                    [ingest/upload.ts]
  -> hash + PocketBase `uploads` row             [registry/pocketbase.ts]
  -> async copy to RustFS (recovery set)         [backup/rustfs.ts]

onboard (workspace scope, no notebook)
  -> Pi session, cwd = workspace dir             [agent/session.ts]
  -> register_dataset creates DuckDB views
  -> agent summarizes + asks questions in chat
  -> save_context writes memory + marks complete

notebook chat / widgets
  -> Pi session (notebook scope) + write_widget
  -> frontend runs widget SQL read-only          [workspace/query.ts]

reconcile (startup) -> scan disk, repair PocketBase projections
restore(workspace_id) -> RustFS + manifest -> rebuild working set
delete(workspace_id) -> disk + registry + backups (full clean)
```

## Agent tools

| tool               | scope            | purpose                                             |
|--------------------|------------------|-----------------------------------------------------|
| `register_dataset` | workspace        | create a DuckDB view over a `data/` file + schema   |
| `duckdb_query`     | both             | SQL against `workspace.duckdb` (serialized)         |
| `suggest_analysis` | workspace        | record a one-click starting analysis                |
| `save_context`     | workspace        | commit `onboarding_context.md`, mark onboarding done |
| `write_widget`     | notebook         | persist a component/artifact widget                 |

DuckDB takes an exclusive file lock, so all CLI invocations are serialized
(`workspace/ducklock.ts`) and the DB tools run sequentially.

## Workspace directory contract

```
/workspaces/{workspace_id}/
├── workspace.json                 # on-disk manifest (authority for existence)
├── workspace.duckdb
├── data/                          # raw uploads — the local working set
├── memory/
│   ├── onboarding_context.md      # confirmed, shared context
│   ├── onboarding.json            # onboarding status (confirmed + data revision)
│   ├── onboarding_transcript.json # workspace-scoped onboarding chat
│   ├── suggested_analyses.json    # one-click starting analyses
│   ├── metadata_schema.json       # registry of views
│   └── user_notes.md              # user-authored context
└── notebooks/{notebook_id}/
    ├── notebook.json
    ├── chat_history.json
    ├── execution.log
    └── generated_assets/
```

`workspace.json`/`notebook.json` are the disk-authoritative manifests
(ADR 0002). Raw uploads live in `data/` and are the local working set queried
by DuckDB (ADR 0001). This contract is the interface between the runner, the
agent, and any future service.

## Isolation model

See [ADR 0003](adr/0003-pi-runner-isolation.md). The app runs in one container;
Pi's `cwd` is the workspace directory. Phase 2: one container per workspace.
The compose runner applies read-only rootfs, `/tmp` tmpfs with `HOME=/tmp`, and
pids/memory/cpu limits.

## Decisions

- [ADR 0001 — Local-first working set, RustFS as recovery set](adr/0001-local-first-storage-and-rustfs-backup.md)
- [ADR 0002 — PocketBase is a registry, not a content store](adr/0002-pocketbase-registry-boundary.md)
- [ADR 0003 — Isolate the Pi runner in a container from day one](adr/0003-pi-runner-isolation.md)
- [ADR 0004 — Two widget modes: live components and static artifacts](adr/0004-widget-modes-component-vs-artifact.md)
- [ADR 0005 — Hard caps instead of retrieval/memory subsystems](adr/0005-quotas-and-caps.md)
- [ADR 0006 — Single-user now, multi-user-ready](adr/0006-single-user-auth-shim.md)
