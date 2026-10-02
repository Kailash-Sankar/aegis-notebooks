# @aegis/mock-source

A mocked **OLTP source system** for the Aegis ingestion platform
([design](../../docs/design/ingestion-platform.md), Phase 1).

It is deliberately *external* to Aegis: a small operational database plus an
HTTP API, so the connector has something realistic to pull from.

- **Storage:** SQLite via the built-in `node:sqlite` (zero dependencies).
- **Generator:** mutates the DB on a loop — new events, follower updates,
  **late-arriving** rows (back-dated `updated_at`), and an optional **schema
  drift** event (adds a column) to exercise re-onboarding.
- **HTTP API:** cursor-paginated, `updated_since`-incremental, with optional
  fault injection (`429`/`500`).

## Run

```bash
pnpm -C mock-source dev          # generator + API on :8099
```

Environment:

| var | default | meaning |
|---|---|---|
| `MOCK_PORT` | `8099` | HTTP port |
| `MOCK_DB` | `mock-source/data/mock.db` | SQLite path (`:memory:` allowed) |
| `MOCK_INTERVAL_MS` | `1500` | generator tick interval |
| `MOCK_LATE_PERCENT` | `0.15` | chance a generated event is a late arrival |
| `MOCK_DRIFT_AFTER_TICKS` | `0` | add `streamers.game` after N ticks (0 = never) |
| `MOCK_SEED` | `42` | RNG seed (reproducible) |
| `MOCK_FAULT_RATE` | `0` | probability of a `429`/`500` per API request |
| `MOCK_GENERATE` | `1` | set `0` to serve a static seeded DB |

## API

```
GET /health
GET /v1/streamers?updated_since=<iso>&cursor=<opaque>&limit=<n>
GET /v1/stream_events?updated_since=<iso>&cursor=<opaque>&limit=<n>
```

Response: `{ "data": [...], "next_cursor": "<opaque>|null", "server_time": "<iso>" }`

- Rows are ordered by `(updated_at, <pk>)`; the cursor is opaque and stable
  across concurrent mutations.
- `updated_since` is the incremental watermark; omit it for a full snapshot.
- This is a **mutable, current-state** store (OLTP), not history.
