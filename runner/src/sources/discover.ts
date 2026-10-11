import type { ContractColumn, SourceContract } from "./contract.js";

/**
 * Deterministic source discovery (design: contract authoring). Given a sample
 * of rows, infer column types, null ratios, candidate keys and candidate
 * cursor fields, and assemble a **draft** SourceContract. No LLM: the agent
 * reviews and finalises the draft.
 */

export interface ColumnProfile {
  name: string;
  /** ClickHouse type (wrapped in Nullable when nulls are present). */
  type: string;
  /** Type without the Nullable wrapper. */
  baseType: string;
  nullRatio: number;
  unique: boolean;
  samples: unknown[];
}

export interface DiscoveryResult {
  rowCount: number;
  columns: ColumnProfile[];
  candidateKeys: string[];
  candidateCursorFields: string[];
  warnings: string[];
  draft: SourceContract;
}

export interface DiscoverArgs {
  source: string;
  dataset: string;
  baseUrl: string;
  endpoint: string;
  pageSize?: number;
  rows: Array<Record<string, unknown>>;
}

const PII_RE = /(^|_)(email|phone|ssn|tax_id|address|full_name|first_name|last_name)($|_)/i;
const CURSOR_NAME_RE = /(updated|created|modified|inserted|_at|_ts|time|timestamp|date)/i;
// Watermark columns track *when a row changed*; event-time columns track when
// the event happened. The partition key uses event time (must be non-null).
const WATERMARK_NAME_RE = /(updated|modified|inserted|created|_ts)/i;
const EVENT_NAME_RE = /(started|ended|occurred|event|_at|time|timestamp|date)/i;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function inferBaseType(values: unknown[]): string {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return "String";
  if (present.every((v) => typeof v === "boolean")) return "Bool";
  if (present.every((v) => typeof v === "number" && Number.isInteger(v))) {
    return present.some((v) => (v as number) < 0) ? "Int64" : "UInt64";
  }
  if (present.every((v) => typeof v === "number")) return "Float64";
  if (present.every((v) => typeof v === "string" && ISO_DATETIME_RE.test(v))) {
    return "DateTime64(3, 'UTC')";
  }
  if (present.every((v) => typeof v === "string" && DATE_RE.test(v))) return "Date";
  return "String";
}

export function profileColumns(
  rows: Array<Record<string, unknown>>,
): ColumnProfile[] {
  const names = new Set<string>();
  for (const row of rows) for (const name of Object.keys(row)) names.add(name);

  const profiles: ColumnProfile[] = [];
  for (const name of [...names].sort()) {
    const values = rows.map((row) => row[name]);
    const present = values.filter((v) => v !== null && v !== undefined);
    const baseType = inferBaseType(values);
    const nullRatio =
      values.length === 0 ? 0 : (values.length - present.length) / values.length;
    const distinct = new Set(present.map((v) => JSON.stringify(v)));
    const unique =
      present.length > 0 && nullRatio === 0 && distinct.size === present.length;
    profiles.push({
      name,
      baseType,
      type: nullRatio > 0 ? `Nullable(${baseType})` : baseType,
      nullRatio,
      unique,
      samples: present.slice(0, 3),
    });
  }
  return profiles;
}

export function discover(args: DiscoverArgs): DiscoveryResult {
  const columns = profileColumns(args.rows);
  // A small sample makes many columns look unique; prefer id-like names so a
  // measure or timestamp is not mistaken for a primary key.
  const uniqueColumns = columns.filter((c) => c.unique);
  const idLike = uniqueColumns.filter((c) =>
    /(^|_)(id|key|uuid|pk)($|_)/i.test(c.name),
  );
  const candidateKeys = (idLike.length > 0 ? idLike : uniqueColumns).map(
    (c) => c.name,
  );
  const timestampColumns = columns.filter(
    (c) => c.baseType.startsWith("DateTime") || c.baseType === "Date",
  );
  // Prefer non-nullable timestamps: a nullable partition key is rejected by
  // ClickHouse and a nullable watermark is a poor resume point.
  const candidateCursorFields = timestampColumns
    .slice()
    .sort((a, b) => {
      const na = a.nullRatio > 0 ? 1 : 0;
      const nb = b.nullRatio > 0 ? 1 : 0;
      if (na !== nb) return na - nb;
      return Number(CURSOR_NAME_RE.test(b.name)) - Number(CURSOR_NAME_RE.test(a.name));
    })
    .map((c) => c.name);
  const nonNullableTs = timestampColumns.filter((c) => c.nullRatio === 0);
  const tsPool = nonNullableTs.length > 0 ? nonNullableTs : timestampColumns;

  const warnings: string[] = [];
  const key = candidateKeys[0];
  const cursor =
    tsPool.find((c) => WATERMARK_NAME_RE.test(c.name))?.name ??
    tsPool.find((c) => CURSOR_NAME_RE.test(c.name))?.name ??
    tsPool[0]?.name;
  const eventTime =
    tsPool.find(
      (c) => EVENT_NAME_RE.test(c.name) && !WATERMARK_NAME_RE.test(c.name),
    )?.name ?? cursor;
  if (!key) {
    warnings.push(
      "no unique column in the sample; defaulting to append with a nominal key",
    );
  }
  if (!cursor) {
    warnings.push("no timestamp column; defaulting to a full sync");
  }

  const contractColumns: Record<string, ContractColumn> = {};
  for (const column of columns) {
    contractColumns[column.name] = {
      type: column.type,
      ...(column.name === eventTime ? { eventTime: true } : {}),
      ...(PII_RE.test(column.name) ? { pii: true } : {}),
    };
  }

  const loadKey =
    candidateKeys.length > 0 ? candidateKeys : [columns[0]?.name ?? "id"];

  const draft: SourceContract = {
    version: 1,
    source: args.source,
    dataset: args.dataset,
    baseUrl: args.baseUrl,
    sync: {
      mode: cursor ? "incremental" : "full",
      endpoint: args.endpoint,
      pageSize: args.pageSize ?? 200,
      ...(cursor ? { cursorField: cursor, cursorParam: "updated_since" } : {}),
    },
    load: {
      target: "clickhouse",
      layer: "ingested",
      mode: key ? "upsert" : "append",
      dedupe: key ? "latest_by_key" : "none",
      key: loadKey,
    },
    columns: contractColumns,
    ...(candidateKeys.length > 0
      ? { quality: { notNull: candidateKeys, unique: candidateKeys } }
      : {}),
    ...(cursor || candidateKeys.length > 0
      ? {
          physical: {
            ...(eventTime ? { partitionBy: `toYYYYMM(${eventTime})` } : {}),
            ...(candidateKeys.length > 0 ? { orderBy: candidateKeys } : {}),
          },
        }
      : {}),
  };

  return {
    rowCount: args.rows.length,
    columns,
    candidateKeys,
    candidateCursorFields,
    warnings,
    draft,
  };
}
