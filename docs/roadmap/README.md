# Roadmap / ideas

Design ideas that are **not yet implemented**, kept in one place so they're easy to
review together. Each spec states the problem, goals/non-goals, a design sketch, risks,
open questions, and milestones — enough to pick up later without re-deriving the context.

| Idea | Status | One-liner |
|---|---|---|
| [Agent-authored transforms](./agent-authored-transforms.md) | idea | Let the agent author prepared/aggregated SQL from the onboarding context, so a new source can be modelled without code changes (`write_transform`). |
| [Ranged hydration](./ranged-hydration.md) | idea | Let the user/agent pick an explicit date window to materialize locally (async job + SSE notification), instead of a fixed 90-day window — important for high-volume sources. |

## Context / examples

- [`../plex-scenario.html`](../plex-scenario.html) — a two-tab learning walkthrough
  (Plex Media Server vs Plex TV telemetry) that shows both the modelling gap and the
  hydration-window problem in a concrete, end-to-end flow.
- [`../design/ingestion-platform.md`](../design/ingestion-platform.md) — the platform
  spec these ideas extend.
- [`../architecture.md`](../architecture.md) — the base application architecture.

## Conventions

- **Status** values: `idea` → `accepted` → `in progress` → `done` (or `dropped`).
- When an idea is implemented, move its durable decisions into an ADR under
  [`../adr/`](../adr/) and link it here.
