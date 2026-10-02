# ADR 0004: Two widget modes — live components and static artifacts

- Status: Accepted
- Date: 2026-09-29

## Context

The dynamic canvas must support both consistent, data-bound dashboard widgets
and expressive, one-off report visuals. A single mode cannot do both well:

- Constrained components are safe, themeable, editable, and re-queryable, but
  limit creative layout.
- Freeform HTML/SVG is expressive, but rendering agent-generated markup in the
  app is an XSS vector and a maintenance burden.

## Decision

Support **two explicit modes**, chosen by the agent (or user) per request:

1. **Component widgets** — a fixed React library (Recharts/Tremor) driven by a
   JSON spec. Live: bound to a DuckDB query, re-runnable, editable, themed.
   Safe by construction. **Default, ~90% of dashboards.**
2. **HTML artifacts** — freeform HTML/SVG, rendered inside a sandboxed
   `<iframe>` with no `allow-same-origin` and a strict CSP. **Static export,
   not a live widget.** The iframe is granted `allow-scripts` solely so an
   injected reporter can postMessage its content height to the parent for
   auto-sizing; the opaque origin and `default-src 'none'` CSP still block
   access to the app, its storage, and the network.

Both modes participate in the notebook's interactive 12-column canvas
(react-grid-layout): the agent proposes `position` (`{ x, y, w, h }`) and the
user can drag/resize, persisted back to the registry.

The two answer different questions (interactive/editable vs expressive/static),
so this is not a compromise between good and bad options.

`widget_specs.type` is `component` or `artifact`. Artifacts are also persisted
as files under `generated_assets/` so the workspace remains self-contained.

**Deferred middle tier:** HTML/CSS-only artifacts (no JS) through a sanitizer,
or a registered-component HTML subset. Not in the MVP.

## Consequences

### Positive
- A safe, consistent default for most visualizations.
- An escape hatch for creative reports without weakening the default.
- Widget specs are small and structured; artifacts are isolated blobs.

### Negative / costs
- Two rendering pipelines and two spec formats to maintain.
- Artifacts are not interactive and cannot be data-bound without a rebuild.
- Sandboxed iframes still need careful CSP and origin handling.

## Alternatives considered

- **Components only.** Rejected: too limiting for report-style output.
- **Freeform HTML only.** Rejected: XSS risk, inconsistent theming, fragile.
- **Agent-generated React components compiled at runtime.** Rejected: build
  pipeline, supply-chain, and correctness risk.
