import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { Config } from "../config.js";

/**
 * The OLAP warehouse (design §4.7). ClickHouse in real runs; an in-memory
 * implementation for tests/dev so the loader is testable without a server.
 */
export interface Warehouse {
  readonly enabled: boolean;
  /** The database all ingested/prepared/aggregated tables live in. */
  readonly database: string;
  /** Run a DDL/command statement (idempotent; uses IF NOT EXISTS). */
  ensureTable(createSql: string): Promise<void>;
  /** Run an arbitrary DDL/DML statement (used by transforms). */
  command(sql: string): Promise<void>;
  /** Run a SELECT and return the result encoded as Parquet bytes. */
  exportParquet(sql: string): Promise<Uint8Array>;
  /** Run a SELECT and return rows as objects. */
  queryRows(sql: string): Promise<Array<Record<string, unknown>>>;
  /** Insert rows as `JSONEachRow`. */
  insert(table: string, rows: Array<Record<string, unknown>>): Promise<void>;
  close(): Promise<void>;
}

export class MemoryWarehouse implements Warehouse {
  readonly enabled = true;
  readonly database = "aegis";
  readonly ddl: string[] = [];
  private readonly tables = new Map<string, Array<Record<string, unknown>>>();

  readonly commands: string[] = [];
  readonly exports: string[] = [];

  async ensureTable(createSql: string): Promise<void> {
    this.ddl.push(createSql);
  }

  async command(sql: string): Promise<void> {
    this.commands.push(sql);
  }

  async exportParquet(sql: string): Promise<Uint8Array> {
    this.exports.push(sql);
    return Buffer.from(`parquet:${this.exports.length}`);
  }

  async queryRows(): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  async insert(
    table: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    const existing = this.tables.get(table) ?? [];
    existing.push(...rows);
    this.tables.set(table, existing);
  }

  rows(table: string): Array<Record<string, unknown>> {
    return this.tables.get(table) ?? [];
  }

  async close(): Promise<void> {}
}

export class ClickHouseWarehouse implements Warehouse {
  readonly enabled = true;
  readonly database: string;
  private readonly client: ClickHouseClient;
  private readonly url: string;
  private readonly user: string;
  private readonly password: string;

  constructor(config: Config) {
    this.database = config.CLICKHOUSE_DB;
    this.url = config.CLICKHOUSE_URL ?? "";
    this.user = config.CLICKHOUSE_USER;
    this.password = config.CLICKHOUSE_PASSWORD;
    this.client = createClient({
      url: config.CLICKHOUSE_URL,
      username: config.CLICKHOUSE_USER,
      password: config.CLICKHOUSE_PASSWORD,
      database: config.CLICKHOUSE_DB,
    });
  }

  async ensureTable(createSql: string): Promise<void> {
    await this.command(createSql);
  }

  async command(sql: string): Promise<void> {
    await this.client.command({ query: sql });
  }

  async exportParquet(sql: string): Promise<Uint8Array> {
    // Use the HTTP interface directly: the client abstracts result formats and
    // does not hand back raw Parquet bytes cleanly. `FORMAT Parquet` on the
    // query returns the encoded file.
    const url = new URL(this.url);
    url.searchParams.set("database", this.database);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-ClickHouse-User": this.user,
        "X-ClickHouse-Key": this.password,
      },
      body: `${sql} FORMAT Parquet`,
    });
    if (!res.ok) {
      throw new Error(
        `ClickHouse export failed: ${res.status} ${await res.text()}`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async queryRows(sql: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.client.query({ query: sql, format: "JSONEachRow" });
    return (await result.json()) as Array<Record<string, unknown>>;
  }

  async insert(
    table: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.client.insert({ table, values: rows, format: "JSONEachRow" });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** ClickHouse when `CLICKHOUSE_URL` is set, else an in-memory warehouse. */
export function createWarehouse(config: Config): Warehouse {
  return config.clickhouseEnabled ? new ClickHouseWarehouse(config) : new MemoryWarehouse();
}
