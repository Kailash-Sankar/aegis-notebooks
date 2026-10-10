# Aegis Notebooks

**Local-first analytical notebooks.** Drop in raw data, have a
[Pi](https://github.com/earendil-works/pi) agent **onboard** it (profile it,
create DuckDB views, write shared context), then open notebooks that answer
questions and build live dashboards.

## Use case

> *"I have a few CSVs/Parquet/log dumps and want to explore them without
> standing up a warehouse."*

1. Create a workspace and upload files (drag & drop, multiple).
2. **Onboard** in a chat: the agent profiles each file, creates DuckDB views,
   summarizes what it found, asks clarifying questions, and — once you confirm —
   saves durable workspace context.
3. Create notebooks. Each has its own chat + canvas and shares the workspace
   context and data. Ask for charts; the agent emits widget specs the UI renders.

Everything runs locally; raw data is backed up immutably and can be restored.

## Tech diagram

```
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│   React UI   │  REST  │  Workspace   │  SQL   │    DuckDB    │
│ chat + canvas│ <────> │   Runner     │ <────> │  (local file)│
└──────┬───────┘  SSE   │  (Pi agent)  │        └──────────────┘
       │                └───┬──────┬───┘
       │ metadata           │      │ raw uploads / backups
       ▼                    ▼      ▼
┌──────────────┐      ┌──────────┐  ┌──────────────┐
│  PocketBase  │      │ local    │  │    RustFS    │
│  (registry)  │      │ disk     │  │ (recovery)   │
└──────────────┘      └──────────┘  └──────────────┘
```

- **Runner** — Node/TypeScript; hosts the Pi agent, DuckDB, ingestion, backups.
- **PocketBase** — registry only (workspaces, uploads, backups, widget specs).
- **RustFS** — immutable backup/recovery set (not on the query path).
- **DuckDB** — analytical SQL over local files.
- **Frontend** — React 19 + Vite + [Astryx](https://github.com/facebook/astryx), Recharts.

See [docs/architecture.md](docs/architecture.md) and the [ADRs](docs/adr/) for
the reasoning (local-first storage, registry boundary, container isolation, etc.).

## Quick start

Requires Node 22+, pnpm, Docker, and the DuckDB CLI.

```bash
pnpm install

# 1) infra: registry + recovery set + transport (Redpanda) + warehouse (CH)
docker compose up -d pocketbase rustfs redpanda clickhouse
docker compose exec pocketbase /usr/local/bin/pocketbase superuser upsert \
  admin@aegis.local aegis-dev-password --dir=/pb/pb_data

# 2) configure the runner
cd runner && cp .env.example .env       # set OPENROUTER_API_KEY (or other provider)

# 3) run
pnpm dev:runner      # http://127.0.0.1:8787
pnpm dev:web         # http://127.0.0.1:5173

# 4) optional: the mocked OLTP source for the ingestion pipeline
pnpm dev:mock        # http://127.0.0.1:8099
```

`docker compose up --build` runs the runner in a hardened container too
(read-only rootfs, `HOME=/tmp`, resource limits; mounts only `workspaces/`).

### Ingestion pipeline (in progress)

Phase 1 is being built per [docs/design/ingestion-platform.md](docs/design/ingestion-platform.md).
A mocked OLTP source (`mock-source/`) feeds a connector + gateway that land
immutable raw chunks in RustFS and publish manifests to Redpanda. An Inngest
workflow then loads each chunk into the ClickHouse **ingested** table
(`ReplacingMergeTree`, deduped by contract key). Redpanda, ClickHouse, and
Inngest run as compose services; the runner falls back to an in-process broker,
an in-memory warehouse, and inline loading when `KAFKA_BROKERS` /
`CLICKHOUSE_URL` / `INNGEST_BASE_URL` are unset.

#### End-to-end run (compose)

```bash
# 1) full stack: registry, raw lake, transport, warehouse, control plane, source
docker compose up -d --build rustfs redpanda clickhouse inngest mock-source runner

# 2) create a workspace
WS=$(curl -s -X POST localhost:8787/workspaces \
  -H 'content-type: application/json' -d '{"name":"demo"}' | jq -r .id)

# 3) give it a source contract (the mock source is reachable as mock-source:8099)
mkdir -p "workspaces/$WS/sources/twitch-mock"
cat > "workspaces/$WS/sources/twitch-mock/contract.json" <<JSON
{
  "version": 1,
  "source": "twitch-mock",
  "dataset": "stream_events",
  "baseUrl": "http://mock-source:8099",
  "sync": { "mode": "incremental", "endpoint": "/v1/stream_events",
            "cursorField": "updated_at", "cursorParam": "updated_since", "pageSize": 500 },
  "load": { "target": "clickhouse", "layer": "ingested", "mode": "upsert",
            "dedupe": "latest_by_key", "key": ["event_id"] },
  "columns": {
    "event_id": { "type": "String" },
    "channel_id": { "type": "UInt64" },
    "updated_at": { "type": "DateTime64(3, 'UTC')", "eventTime": true }
  },
  "quality": { "notNull": ["event_id"] }
}
JSON

# 4) pull: connector -> raw (RustFS) -> Redpanda -> Inngest -> ClickHouse ingested
curl -X POST "localhost:8787/workspaces/$WS/sources/twitch-mock/pull"

# 5) verify
curl -s 'http://localhost:8123/?query=SELECT%20count()%20FROM%20aegis.ingested_stream_events' \
  --user aegis:aegis-dev-password
```

Notes: `redpanda-init` creates `ingest.chunks` (6 partitions, keyed by
`workspace_id`), `ingest.dlq`, and `warehouse.events`. The Inngest dev UI is at
<http://localhost:8288>; wait for `apps synced` in `docker compose logs inngest`
before the first pull so the workflow is registered. If Inngest is unreachable
the bridge falls back to loading inline (dev convenience), so ingestion still
completes.

### Model

```bash
# runner/.env
OPENROUTER_API_KEY=sk-or-...
AEGIS_MODEL=openrouter/z-ai/glm-5.3-flash   # provider/model-id
AEGIS_THINKING=medium
```

`AEGIS_MODEL` splits on the first slash. List available models with
`cd runner && pnpm models`. Use a model that supports **tool calling**.

## Observability

The runner emits OpenTelemetry **metrics** over OTLP; the Collector batches them
and exposes a Prometheus endpoint. Metrics are the backbone — logs are
errors-only and traces are sampled — so the pipeline is visible without bloat.

```bash
docker compose up -d otel-collector
curl -s localhost:8889/metrics | grep '^aegis_'   # scrape endpoint
```

Metric families: `aegis.ingest.chunks|rows|dedupe`, `aegis.jobs.runs|duration`,
`aegis.http.requests|duration`, `aegis.queue.pending`, and
`aegis.freshness.seconds` (per workspace) — the last is the primary "is the data
current?" signal. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to turn telemetry on (no-op
when unset).

**SigNoz:** the Collector is the seam — uncomment the `otlp/signoz` exporter in
`otel-collector-config.yaml` and run SigNoz to send the same metrics to its UI.
No app changes are needed.

## Tests

```bash
pnpm typecheck
pnpm test        # runner + mock-source units
pnpm build:web
```

## HTTP API (runner)

| method | path | purpose |
|---|---|---|
| GET | `/health` | liveness (`?deep=1` pings PocketBase) |
| GET/POST | `/workspaces` | list / create |
| GET/DELETE | `/workspaces/:id` | fetch / full clean (disk + registry + backups) |
| GET | `/workspaces/:id/data` | list raw files |
| POST | `/workspaces/:id/uploads` | upload (`x-filename` header) |
| GET | `/workspaces/:id/context` | onboarding status + context + notes + suggestions |
| PUT | `/workspaces/:id/notes` | save user notes |
| POST | `/workspaces/:id/query` | read-only SQL → rows |
| POST | `/workspaces/:id/sources/:source/pull` | pull + land a source chunk (operator; `?check=1` fails on drift) |
| GET | `/workspaces/:id/sources/:source/check` | detect contract drift against the live source |
| GET/POST | `/workspaces/:id/hydrate` | fetch / refresh the DuckDB hydration window |
| GET | `/workspaces/:id/insights` | background-computed headline findings |
| GET | `/scheduler` | job definitions + recent runs |
| POST | `/scheduler/run/:id` | trigger a scheduled job now (operator) |
| POST | `/workspaces/:id/restore` | rebuild from RustFS |
| POST | `/workspaces/:id/onboard` | start onboarding (SSE) |
| POST | `/workspaces/:id/onboard/chat` | continue onboarding chat (SSE) |
| GET | `/workspaces/:id/onboard/transcript` | onboarding chat history |
| POST | `/workspaces/:id/onboard/reset` | clear onboarding context |
| GET/POST | `/workspaces/:id/notebooks` | list / create |
| POST | `/workspaces/:id/notebooks/:nb/chat` | notebook chat (SSE) |
| GET | `/workspaces/:id/notebooks/:nb/widgets` | widget specs |
| PUT | `/workspaces/:id/notebooks/:nb/layout` | persist canvas drag/resize |
| GET | `/workspaces/:id/notebooks/:nb/reports` | list full-page reports |
| GET | `/workspaces/:id/notebooks/:nb/reports/:reportId` | fetch a report body |
| DELETE | `/workspaces/:id/notebooks/:nb/reports/:reportId` | delete a report |
| GET | `/workspaces/:id/notebooks/:nb/transcript` | notebook chat history |

## Security

No credentials are committed. `runner/.env` is gitignored (start from
`.env.example`). The dev values in `docker-compose.yml` are local-only defaults.
Model-generated shell commands run inside the container (ADR 0003).
