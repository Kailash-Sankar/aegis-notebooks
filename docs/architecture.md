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
  -> every turn ends with an SSE `done` event carrying `contextSaved` (did
     save_context run this turn?) and `onboarding` (post-turn status), so the UI
     confirms memory changed instead of inferring it from a file diff.

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
| `write_report`     | notebook         | persist a full-page static report (HTML/SVG)        |

### Reports (static, Tier 1)

A notebook has two surfaces under the same chat: **Dashboard** (the interactive
grid of live components and static artifact tiles) and **Report** (a full-page
static document). The agent writes reports with `write_report`; they are
self-contained HTML/SVG fragments with data baked in from SQL, rendered
scriptless in a sandboxed iframe, and can be downloaded or printed to PDF.
Reports live on disk per notebook (`reports/index.json` + `reports/<id>.html`),
consistent with disk-as-authority (ADR 0002). A future Tier 2 can make reports
block-based so prose and live widgets compose into one document.

### Canvas layout

The notebook canvas is an interactive **12-column grid** (react-grid-layout).
`write_widget` takes a `position` (`{ x, y, w, h }`); the agent proposes the
initial layout and the user can **drag and resize**, with the arrangement
persisted via `PUT .../notebooks/:id/layout`. Missing positions default to half
width (`w: 6`). Common spans: `w: 12` for full-width KPI strips and wide
tables, `w: 6` for two charts per row, `w: 3`/`w: 4` for small multiples.
Widgets are dragged from their header handle; `h: 1` ~= 100px.

Component widgets support `bar | line | area | pie | kpi | stackedBar | table |
heatmap`. `kpi` renders themed metric cards from `x` (metric name) and `y`
(value) columns, so headline metrics do not need a hand-built HTML artifact.
Charts fill their grid cell (measured, responsive); they are not fixed-height.

Widgets auto-size when their content would be clipped. KPI component strips
estimate the rows their cards need at the current cell width; artifact iframes
post their content height to the parent. In both cases the canvas grows the
grid row just enough to fit. The artifact iframe uses `allow-scripts` (for that
reporter) but **not** `allow-same-origin`, and a strict CSP blocks all network
access.

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
    ├── generated_assets/   # widget artifacts
    └── reports/            # full-page reports: index.json + <id>.html
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

## Proposed designs

- [Ingestion, Warehouse & Serving Platform](design/ingestion-platform.md) —
  proposed (not yet implemented): mocked OLTP source, contract-driven ELT into
  ClickHouse, Redpanda transport, Inngest orchestration, windowed hydration into
  DuckDB, and low-noise observability. Extends ADR 0001/0002.

## Decisions

- [ADR 0001 — Local-first working set, RustFS as recovery set](adr/0001-local-first-storage-and-rustfs-backup.md)
- [ADR 0002 — PocketBase is a registry, not a content store](adr/0002-pocketbase-registry-boundary.md)
- [ADR 0003 — Isolate the Pi runner in a container from day one](adr/0003-pi-runner-isolation.md)
- [ADR 0004 — Two widget modes: live components and static artifacts](adr/0004-widget-modes-component-vs-artifact.md)
- [ADR 0005 — Hard caps instead of retrieval/memory subsystems](adr/0005-quotas-and-caps.md)
- [ADR 0006 — Single-user now, multi-user-ready](adr/0006-single-user-auth-shim.md)
