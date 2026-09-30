# ADR 0005: Hard caps instead of retrieval/memory subsystems (for now)

- Status: Accepted
- Date: 2026-09-29

## Context

Workspace context (`onboarding_context.md`, `user_notes.md`, uploaded reference
files) grows without bound, and uploaded data can be arbitrarily large. The
full solutions — chunking, embeddings, retrieval, query result streaming — are
real subsystems.

For the MVP we want deterministic, cheap guards rather than a new subsystem.

## Decision

Enforce **configurable hard caps**, failing loudly with clear errors. No
retrieval or embedding layer yet.

Per-workspace caps (config values, not constants):

- total bytes on disk
- per-file bytes
- file count
- maximum rows/size a DuckDB query may materialize into a widget

Memory context is maintained under a **token budget** with explicit compaction
(truncate/roll up oldest notes) rather than retrieval.

## Consequences

### Positive
- Bounded resource use with no new infrastructure.
- Clear, actionable errors for the user.
- Defers the real retrieval work until it is justified.

### Negative / costs
- Large legitimate datasets are rejected until streaming/retrieval lands.
- Compaction can drop context the agent would have wanted.

## Alternatives considered

- **Embeddings + retrieval now.** Deferred: significant subsystem, not needed
  to prove the core loop.
- **No caps.** Rejected: unbounded growth can take down a local machine.
