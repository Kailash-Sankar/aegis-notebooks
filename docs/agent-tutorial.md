# Aegis — Agent Onboarding & Tutorial

> **Audience: a coding agent (or a human) driving this repo for the first time.**
> Read this top to bottom once, then use it as a runbook. It tells you what the
> system is, how to bring it up, how to prove it works end to end, and the rules
> you must not break. Commands assume the repo root.
>
> **Not to be confused with the `AGENTS.md` convention.** Those are per-project
> instruction files (e.g. [`../web/AGENTS.md`](../web/AGENTS.md) and the injected
> workspace context). This document is a tutorial/runbook, not an instruction file.

## 1. What this repo is

**Aegis Notebooks** is a local-first analytical notebook:

- A **runner** (Node/TypeScript) hosts the API and a Pi agent, and owns disk storage
  under `workspaces/`.
- A **web** app (React/Vite) is the notebook UI (agent chat + dashboard/report/insights).
- A **mock-source** simulates an external OLTP system feeding an ingestion pipeline.
- On top sits a **batch analytics platform**: contract-driven pull → immutable raw lake
  → transport → OLAP warehouse → local serving cache → notebooks.

Three pnpm packages: `runner/`, `web/`, `mock-source/`.

**Your job as an agent:** get it running, run the tests, walk one source end to end,
and respect the invariants in §10.

## 2. TL;DR (the 5-minute path)

```bash
pnpm install
cp runner/.env.example .env            # then set OPENROUTER_API_KEY (see §6)
docker compose up -d --build pocketbase rustfs redpanda clickhouse inngest mock-source runner
docker compose exec pocketbase /usr/local/bin/pocketbase superuser upsert \
  admin@aegis.local aegis-dev-password --dir=/pb/pb_data
curl -fsS localhost:8787/health        # → {"ok":true,"registry":true,...}
pnpm dev:web                           # → http://localhost:5173
```

Then follow §8 to pull a source end to end.

## 3. Prerequisites

- **Node >= 22**, **pnpm**, **Docker + Docker Compose**, and the **DuckDB CLI** (`duckdb`).
- A model provider key for the in-app agent (optional — the pipeline works without it).

## 4. Repo map

```
runner/                     # API + Pi agent + warehouse/ingest code
  src/agent/                # session, tools, instructions (the Pi agent)
  src/sources/              # contracts, connector, discovery, drift, secrets, pull
  src/ingest/               # gateway (land raw), bridge (publish manifests), quota
  src/raw/                  # RustFS / in-memory raw store
  src/transport/            # Redpanda (Kafka) broker + topics
  src/warehouse/            # ClickHouse client, ingested DDL, loader, transforms
  src/workflows/inngest.ts  # durable load workflow
  src/hydrate/              # windowed Parquet export -> DuckDB views
  src/scheduler/            # hand-rolled periodic jobs
  src/insights/             # aggregated_insights SQL
  src/registry/             # PocketBase projection
  src/telemetry/            # OTel metrics
web/                        # React notebook UI (Dashboard | Report | Insights)
mock-source/                # SQLite + generator + cursor-paginated HTTP API
workspaces/                 # ⚠ local-first data (gitignored). Disk is authority.
docs/                       # design, ADRs, roadmap ideas, learning docs
docker-compose.yml          # infra + containerized runner
```

## 5. Architecture in ten lines

```
upload (CSV) ─────────────▶ data/ → DuckDB view ─────────────┐
                                                             ▼
external source ──contract──▶ pull → RustFS raw (AUTHORITY)  notebook / agent
                                 + manifest (claim check)      (queries DuckDB)
                                     │
                                     ▼
                     Redpanda ingest.chunks → Inngest ingest-chunk-load
                                     │
                                     ▼
        ClickHouse: ingested_* (generic) → prepared_* / aggregated_* (authored SQL)
                                     │
                          hydrate 90d → Parquet → DuckDB hydrate_* views
```

- **RustFS raw is the authority.** ClickHouse is a *rebuildable projection*; DuckDB is a
  *disposable* local cache; PocketBase is a *catalog projection*. The acid test: you can
  drop ClickHouse and rebuild from raw + contracts.
- Delivery is **at-least-once**; every write is **idempotent**.

## 6. Configuration

Two files, both **gitignored** — never commit secrets:

- **Root `.env`** — used by `docker compose` for the containerized runner:
  `OPENROUTER_API_KEY`, `AEGIS_MODEL`, `AEGIS_THINKING`,
  `POCKETBASE_ADMIN_EMAIL=admin@aegis.local`, `POCKETBASE_ADMIN_PASSWORD=aegis-dev-password`.
- **`runner/.env`** — used when running the runner on the host (`pnpm dev:runner`).
  Full key list: `runner/.env.example`.

Compose already wires container-internal URLs (`clickhouse:8123`, `redpanda:29092`,
`inngest:8288`, `rustfs:9000`, `mock-source:8099`). On the host, use `127.0.0.1:<port>`.

Key env vars: `CLICKHOUSE_*`, `KAFKA_BROKERS`, `INNGEST_BASE_URL`/`INNGEST_DEV`,
`RUSTFS_RAW_BUCKET`, `SCHEDULER_*`, `OTEL_EXPORTER_OTLP_ENDPOINT`.
**Leaving infra vars unset makes the runner fall back to in-memory / inline modes** —
handy for unit work with zero Docker.

## 7. Start the stack (recommended: Docker infra + runner)

```bash
pnpm install
docker compose up -d --build \
  pocketbase rustfs redpanda clickhouse inngest mock-source runner
```

- `redpanda-init` creates topics `ingest.chunks` (6), `ingest.dlq` (3), `warehouse.events` (6).
- Inngest dev UI: <http://localhost:8288> — wait for `apps synced`.
- Compose ports: PocketBase 8090 · RustFS 9000/9001 · Redpanda 9092 · ClickHouse 8123 ·
  Inngest 8288 · mock-source 8099 · runner 8787 · otel-collector 4318/8889.

**Web UI runs on the host** (talk to the runner via Vite's `/api` proxy):

```bash
pnpm dev:web   # http://localhost:5173
```

### Alternative: everything on the host

```bash
docker compose up -d pocketbase rustfs redpanda clickhouse inngest mock-source
cd runner && cp .env.example .env   # set host URLs + model key
pnpm dev:runner                      # http://127.0.0.1:8787
pnpm dev:web
```

Do **not** run the compose `runner` and `pnpm dev:runner` at once (port 8787 clash).

## 8. End-to-end tour (prove it works)

The mock source exposes two datasets: `stream_events` and `streamers` (open API, no auth).

```bash
# 1) create a workspace
WS=$(curl -s -X POST localhost:8787/workspaces -H 'content-type: application/json' \
       -d '{"name":"tour"}' | jq -r .id); echo "WS=$WS"

# 2) discover a source (samples rows, infers a draft contract)
curl -s -X POST "localhost:8787/workspaces/$WS/sources/discover" \
  -H 'content-type: application/json' \
  -d '{"source":"twitch-mock","dataset":"stream_events",
       "baseUrl":"http://mock-source:8099","endpoint":"/v1/stream_events"}' | jq '.candidateKeys, .columns'

# 3) save a contract (use the draft from step 2, or write it directly)
curl -s -X PUT "localhost:8787/workspaces/$WS/sources/twitch-mock/contract" \
  -H 'content-type: application/json' -d @- <<'JSON'
{"contract":{
  "version":1,"source":"twitch-mock","dataset":"stream_events",
  "baseUrl":"http://mock-source:8099",
  "sync":{"mode":"incremental","endpoint":"/v1/stream_events",
          "cursorField":"updated_at","cursorParam":"updated_since","pageSize":500},
  "load":{"target":"clickhouse","layer":"ingested","mode":"upsert",
          "dedupe":"latest_by_key","key":["event_id"]},
  "columns":{"event_id":{"type":"String"},"channel_id":{"type":"UInt64"},
             "started_at":{"type":"DateTime64(3, 'UTC')"},
             "updated_at":{"type":"DateTime64(3, 'UTC')","eventTime":true}},
  "quality":{"notNull":["event_id"]}
}}
JSON

# 4) pull -> raw -> Redpanda -> Inngest -> ClickHouse
curl -s -X POST "localhost:8787/workspaces/$WS/sources/twitch-mock/pull" | jq '{chunks,rows,watermark}'

# 5) rebuild marts + hydrate the DuckDB window, then compute insights
curl -s -X POST localhost:8787/scheduler/run/warehouse-refresh >/dev/null
curl -s -X POST localhost:8787/scheduler/run/insights >/dev/null
curl -s "localhost:8787/workspaces/$WS/insights" | jq .

# 6) verify the warehouse directly
curl -s 'http://localhost:8123/?query=SELECT%20count()%20FROM%20aegis.ingested_stream_events' \
  --user aegis:aegis-dev-password
```

Expected: hundreds of chunks/rows land; `ingested_stream_events`, `prepared_stream_events`,
`aggregated_*` appear; `hydrate_*` views are created in `workspaces/$WS/workspace.duckdb`;
insights return rows (a "total watch minutes today" card, top channel, anomalies).

**In the UI:** New workspace → **Warehouse sources → Connect source** (twitch-mock,
`http://mock-source:8099`, `/v1/stream_events`, auth **None**) → **Discover** → **Sync now**
→ **Refresh warehouse** → run onboarding → check the **Insights** tab.

Watch the load runs live at <http://localhost:8288> (one `ingest-chunk-load` per chunk).

### Auth path (optional)

```bash
# enable the mock's API-key mode, then:
docker compose up -d mock-source           # with MOCK_API_KEY=demo-key in .env
curl -s -X PUT "localhost:8787/workspaces/$WS/sources/authed/credentials" \
  -H 'content-type: application/json' -d '{"secrets":{"TWITCH_API_KEY":"demo-key"}}'
# discover/pull with auth {type:"bearer",secretRef:"TWITCH_API_KEY"}
```

Secrets resolve from env → gitignored `sources/<src>/credentials.json` (mode 0600) and are
**never** stored in the contract or echoed back.

## 9. Verify the codebase

```bash
pnpm -C runner typecheck        # tsc --noEmit
pnpm -C runner test             # node --test (unit tests)
pnpm -C mock-source test
pnpm -C web build               # tsc -b && vite build
pnpm -r run typecheck           # all packages
```

Note: macOS has no `timeout`/`gtimeout`; don't run two `pnpm -C` concurrently (lock races).

## 10. Invariants & house rules (do not break these)

1. **Disk is authority; every projection is rebuildable.** Never make PocketBase or
   ClickHouse the source of truth. Raw (`RustFS raw/`) is immutable and append-only.
2. **Claim check**: queues carry *pointers/manifests*, never bulk bytes (ADR 0008).
3. **At-least-once + idempotent**: raw is content-addressed; warehouse dedupes
   (`ReplacingMergeTree`). Re-running must be safe.
4. **Contracts are the only place source semantics live.** They are validated against the
   published JSON Schema (`runner/src/sources/contract.schema.json`). Never put secrets in
   a contract — only a `secretRef`.
5. **Two widget modes** (ADR 0004): live `component` (React/Recharts) vs static `artifact`
   (sandboxed iframe, no `allow-same-origin`). Reports run **fully scriptless**.
6. **Local-only**: no SaaS. Observability is OTel + a local collector.
7. **Layer names are `ingested` → `prepared` → `aggregated`** (formerly bronze/silver/gold).
   `ingested` is generic/contract-driven; `prepared`/`aggregated` are authored SQL.
8. **Tests before commit**: run `runner` tests + typecheck and `pnpm -C web build`.
9. **Never commit** `.env`, `workspaces/`, or credentials files.

## 11. HTTP API surface (to drive it programmatically)

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness (`registry`, `backups`, `raw`, `warehouse` flags) |
| `GET/POST /workspaces` | list / create workspaces |
| `DELETE /workspaces/:id` | delete (cascades disk + registry) |
| `GET/POST /workspaces/:id/sources` … discover | list / discover a source |
| `PUT …/sources/:src/contract` · `…/credentials` | save contract / secrets |
| `POST …/sources/:src/pull` | pull + land (incremental) |
| `GET …/sources/:src/check` | drift check |
| `GET/POST /workspaces/:id/hydrate` | hydration manifest / export window |
| `GET /workspaces/:id/insights` | background-computed findings |
| `GET /workspaces/:id/context` · `PUT …/notes` | workspace memory / user notes |
| `POST /workspaces/:id/onboard` · `…/onboard/chat` | streamed onboarding (SSE) |
| `GET/POST /workspaces/:id/notebooks` | notebooks |
| `POST …/notebooks/:nb/chat` | streamed agent chat (SSE) |
| `GET …/notebooks/:nb/widgets` · `…/reports` | dashboard / reports |
| `GET/POST /scheduler` · `POST /scheduler/run/:id` | job status / run now |
| `GET /api/inngest` | Inngest function registry |

## 12. The in-app agent's tools

The Pi agent drives the workspace with these tools (see `runner/src/agent/tools.ts`):
`duckdb_query`, `register_dataset`, `discover_source`, `write_source_contract`,
`list_sources`, `sync_source`, `suggest_analysis`, `write_widget`, `write_report`,
`save_context`. Onboarding is a conversation that ends with `save_context` writing
`memory/onboarding_context.md`.

## 13. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `403 Only superusers…` creating a workspace | PocketBase superuser missing, or an expired cached token. The runner now re-auths on 401/403; ensure the superuser was upserted. |
| Ingest never loads (empty `ingested_*`) | Inngest not synced yet, or ClickHouse unreachable. Check `docker compose logs inngest runner`; with `INNGEST_*` unset the bridge loads **inline**. |
| `Unknown table expression aegis.ingested_*` | Load hasn't run yet — wait, or run `POST /scheduler/run/warehouse-refresh` after the load. |
| `Partition key contains nullable columns` | A contract picked a nullable `eventTime`. Discovery now prefers non-nullable and unwraps nullables; re-discover. |
| Model/agent does nothing | `OPENROUTER_API_KEY` not set for the runner (root `.env` for compose, `runner/.env` for host). |
| Port 8787 in use | Don't run compose `runner` and `pnpm dev:runner` together. |
| Redpanda consumer lag / Kafkajs group join slow | Harmless in dev; the bridge reads `fromBeginning:true` and is idempotent. |

### Clean slate

```bash
docker compose stop runner
docker compose exec clickhouse clickhouse-client --user aegis --password aegis-dev-password \
  -q 'DROP DATABASE IF EXISTS aegis; CREATE DATABASE IF NOT EXISTS aegis;'
find workspaces -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
# optionally: docker compose down -v   # wipes ALL volumes (raw, mock data, pb)
```

## 14. Where to read more

- [`README.md`](../README.md) — human quick start + ingestion runbook.
- [`docs/architecture.md`](./architecture.md) — base app architecture.
- [`docs/design/ingestion-platform.md`](./design/ingestion-platform.md) — the platform spec.
- [`docs/system-design.html`](./system-design.html) — the whole system, visually.
- [`docs/plex-scenario.html`](./plex-scenario.html) — a two-tab end-to-end learning doc.
- [`docs/adr/`](./adr/) — decisions (authority model, claim check, contracts, widget modes).
- [`docs/roadmap/`](./roadmap/) — ideas not yet built (agent-authored transforms, ranged hydration).
