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

# 1) registry + recovery set
docker compose up -d pocketbase rustfs
docker compose exec pocketbase /usr/local/bin/pocketbase superuser upsert \
  admin@aegis.local aegis-dev-password --dir=/pb/pb_data

# 2) configure the runner
cd runner && cp .env.example .env       # set OPENROUTER_API_KEY (or other provider)

# 3) run
pnpm dev:runner      # http://127.0.0.1:8787
pnpm dev:web         # http://127.0.0.1:5173
```

`docker compose up --build` runs the runner in a hardened container too
(read-only rootfs, `HOME=/tmp`, resource limits; mounts only `workspaces/`).

### Model

```bash
# runner/.env
OPENROUTER_API_KEY=sk-or-...
AEGIS_MODEL=openrouter/z-ai/glm-5.3-flash   # provider/model-id
AEGIS_THINKING=medium
```

`AEGIS_MODEL` splits on the first slash. List available models with
`cd runner && pnpm models`. Use a model that supports **tool calling**.

## Tests

```bash
pnpm typecheck
pnpm test        # runner units (ids, quotas, mappers, restore, tools, context)
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
