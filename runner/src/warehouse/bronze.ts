import type { SourceContract } from "../sources/contract.js";

/**
 * Bronze table DDL generation (design §4.7). Contract column types are already
 * ClickHouse type strings, but they are still validated before interpolation —
 * a contract is agent-authored and must not be able to inject SQL.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// e.g. UInt64, LowCardinality(String), DateTime64(3, 'UTC'), Nullable(Int64)
const TYPE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\([A-Za-z0-9_, ']+\))?$/;

export function assertIdentifier(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

export function assertColumnType(type: string): string {
  if (!TYPE_RE.test(type)) throw new Error(`unsafe column type: ${type}`);
  return type;
}

/** Metadata columns every bronze table carries. */
export const META_COLUMNS = [
  "tenant_id",
  "workspace_id",
  "_source",
  "_chunk_id",
  "_ingested_at",
  "_version",
] as const;

export function bronzeTableName(contract: SourceContract): string {
  return `bronze_${assertIdentifier(contract.dataset)}`;
}

function eventTimeColumn(contract: SourceContract): string | undefined {
  return Object.entries(contract.columns).find(([, c]) => c.eventTime)?.[0];
}

/**
 * `CREATE TABLE IF NOT EXISTS` for a dataset's bronze table. Upsert contracts
 * use `ReplacingMergeTree(_version)` so the engine keeps the newest row per
 * `ORDER BY` key; append contracts use plain `MergeTree`.
 */
export function bronzeDdl(database: string, contract: SourceContract): string {
  const db = assertIdentifier(database);
  const table = bronzeTableName(contract);

  const columns: string[] = [
    "tenant_id LowCardinality(String)",
    "workspace_id LowCardinality(String)",
  ];
  for (const [name, col] of Object.entries(contract.columns)) {
    columns.push(`${assertIdentifier(name)} ${assertColumnType(col.type)}`);
  }
  columns.push(
    "_source LowCardinality(String)",
    "_chunk_id String",
    "_ingested_at DateTime64(3, 'UTC')",
    "_version UInt64",
  );

  const eventCol = eventTimeColumn(contract);
  const partition = eventCol
    ? `toYYYYMM(${assertIdentifier(eventCol)})`
    : "toYYYYMM(_ingested_at)";
  const orderBy = ["tenant_id", "workspace_id", ...contract.load.key.map(assertIdentifier)].join(
    ", ",
  );
  const engine =
    contract.load.dedupe === "latest_by_key"
      ? "ReplacingMergeTree(_version)"
      : "MergeTree()";

  return (
    `CREATE TABLE IF NOT EXISTS ${db}.${table} ` +
    `(${columns.join(", ")}) ` +
    `ENGINE = ${engine} ` +
    `PARTITION BY ${partition} ` +
    `ORDER BY (${orderBy})`
  );
}
