import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { Config } from "../config.js";

/**
 * The OLAP warehouse (design §4.7). ClickHouse in real runs; an in-memory
 * implementation for tests/dev so the loader is testable without a server.
 */
export interface Warehouse {
  readonly enabled: boolean;
  /** The database all bronze/silver/gold tables live in. */
  readonly database: string;
  /** Run a DDL/command statement (idempotent; uses IF NOT EXISTS). */
  ensureTable(createSql: string): Promise<void>;
  /** Insert rows as `JSONEachRow`. */
  insert(table: string, rows: Array<Record<string, unknown>>): Promise<void>;
  close(): Promise<void>;
}

export class MemoryWarehouse implements Warehouse {
  readonly enabled = true;
  readonly database = "aegis";
  readonly ddl: string[] = [];
  private readonly tables = new Map<string, Array<Record<string, unknown>>>();

  async ensureTable(createSql: string): Promise<void> {
    this.ddl.push(createSql);
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

  constructor(config: Config) {
    this.database = config.CLICKHOUSE_DB;
    this.client = createClient({
      url: config.CLICKHOUSE_URL,
      username: config.CLICKHOUSE_USER,
      password: config.CLICKHOUSE_PASSWORD,
      database: config.CLICKHOUSE_DB,
    });
  }

  async ensureTable(createSql: string): Promise<void> {
    await this.client.command({ query: createSql });
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
