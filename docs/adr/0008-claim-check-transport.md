# ADR 0008: Claim-check transport — queues carry pointers, not payloads

- Status: Proposed
- Date: 2026-10-03

## Context

The ingestion pipeline moves chunks from the gateway to the loader through
Redpanda. A chunk can be large (hundreds of KB to many MB). We must decide what a
queue message contains: the **data itself**, or a **reference** to it.

## Decision

Queue messages carry **claim checks** — small manifests/pointers (ids, object
keys, hashes, cursor). Bulk bytes are written to RustFS first (ADR 0007), and the
consumer reads them by key.

- The `chunk.landed` message is the **chunk manifest** (see design §4.4), not the
  payload.
- Exactly **one** authoritative copy of the bytes exists (RustFS raw).
- Consumers must be idempotent and must tolerate a fetch failure (retry / DLQ).

## Consequences

### Positive
- The broker stays small and fast; no broker size limits or duplicate storage.
- Retention is decoupled: raw is durable in RustFS regardless of broker retention.
- Replay re-reads the same immutable object.

### Negative / costs
- An extra fetch hop per message (broker → RustFS).
- Must handle partial state: "pointer exists, object missing" (treat as
  transient, retry, else DLQ).
- Object-level access control must be enforced on the read path.

## Alternatives considered

- **Inline payloads in messages.** Rejected: broker bloat, message-size limits,
  duplicate storage, retention coupling between broker and lake.
- **Store the payload in ClickHouse and pass its key.** Rejected: conflates
  transport with the (rebuildable) warehouse and makes the queue depend on CH.
