# ADR 0006: Single-user now, multi-user-ready via an owner column and a shim

- Status: Accepted
- Date: 2026-09-29

## Context

The MVP targets a single local user, and building login/OAuth/session UI now is
premature. But a plausible future is multiple users sharing a workspace, each
with their own notebooks. A late move to multi-user would otherwise require a
painful data migration.

## Decision

**Ship no auth in the MVP**, with two pieces of cheap insurance:

1. **Owner columns from day one.** `workspaces.owner_id` and
   `notebooks.owner_id` are set to a fixed `"local"` user.
2. **A `currentUser()` shim** in the backend returns the local user. When auth
   is added, only the shim changes — call sites do not.

Do **not** build login, sessions, or permission checks yet. PocketBase already
ships an auth system, so enabling it later is adopting a feature rather than
building one.

Sharing/permissions semantics (who can see whose notebook) are explicitly
deferred; the schema simply does not preclude them.

## Consequences

### Positive
- Zero auth code and zero auth UX in the MVP.
- No schema migration when multi-user arrives.
- A single swap point (`currentUser()`) for future authorization.

### Negative / costs
- The MVP is not safe to expose on a network (single hardcoded user).
- Owner columns are unused until auth lands, which can look like dead weight.

## Alternatives considered

- **Full auth from day one.** Rejected: wasted effort before the core loop is
  proven; PocketBase makes adoption later cheap.
- **No owner columns at all.** Rejected: forces a data migration later.
