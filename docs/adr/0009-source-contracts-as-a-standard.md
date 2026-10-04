# ADR 0009: Source contracts are a published, agent-bootstrapped standard

- Status: Proposed
- Date: 2026-10-04

## Context

Ingestion needs a durable mapping from a source dataset to its warehouse table:
column types, primary key, cursor field, dedupe strategy, PII, and quality rules.
Two extremes are common in industry:

- **Opaque inference** (Fivetran/Stitch): fast, but the mapping is hidden, hard to
  review, and impossible to port.
- **Hand-written config** (declarative connectors): portable, but every source is
  manual work and drifts silently.

We already have a `SourceContract` document and a runtime `parseContract`
validator, but no published specification, no bootstrapping, and no drift
detection.

## Decision

The `SourceContract` is a **declarative artifact** with a **published JSON
Schema** — the standard — and is **bootstrapped deterministically** then
**finalised by the agent**.

1. `runner/src/sources/contract.schema.json` is the published schema
   (draft-07). `validateContractSchema` (Ajv) enforces it; `parseContract`
   remains the typed runtime validator.
2. **`discover_source`** (deterministic, no LLM) samples a source and infers
   column types, null ratios, candidate keys (id-like columns preferred) and
   candidate cursor fields, returning a **draft** contract.
3. **`write_source_contract`** (agent tool) validates a contract against the
   schema and persists it to `sources/{source}/contract.json`.
4. Contracts stay **disk-authoritative** (ADR 0002) with a PocketBase metadata
   projection.
5. **Drift** is detected by diffing discovered columns against the contract
   (`diffColumns`) and by `schemaFingerprint`; **additive** drift is applied by
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, while removals/type changes need
   review.

Semantic conventions on fields (`eventTime`, `pii`, `load.key`,
`sync.cursorField`) play the role OTel's semantic conventions do: they give the
spec meaning beyond shape.

## Consequences

### Positive
- The contract is reviewable, versioned, and machine-validated (fail fast).
- Bootstrap is automatic; the agent only resolves genuine ambiguity.
- Portability: the schema/roles allow adapters (dbt `sources.yml`, Airbyte
  manifest) without changing the app.
- Drift is visible and mostly self-healing (additive changes).

### Negative / costs
- Two validators (`parseContract` + schema) must stay in agreement — covered by
  a cross-check test.
- Deterministic inference is heuristic (keys, cursor choices) and can be wrong
  on small samples; the agent/user must confirm.
- Type changes and column removals still require a deliberate migration.

## Alternatives considered

- **Opaque managed inference.** Rejected: unreviewable and non-portable.
- **Hand-written config only.** Rejected: manual toil and silent drift.
- **A universal data-contract standard (ODCS) directly.** Deferred: the goal now
  is a well-specified local contract with export adapters, which is how OTel
  itself began (spec + conventions first, ecosystem later).
