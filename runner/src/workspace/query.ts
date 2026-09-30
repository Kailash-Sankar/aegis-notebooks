import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { withDuckdbLock } from "./ducklock.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export interface QueryResult {
  rows: unknown[];
  truncated: boolean;
  rowCount: number;
}

/**
 * Execute read-only SQL against the workspace DuckDB database and return rows.
 * Enforces the widget row cap (ADR 0005) by truncating large result sets.
 *
 * Writes are blocked at the engine level (`-readonly`), so even a crafted
 * statement cannot mutate the database.
 */
export async function runQuery(
  config: Config,
  duckdbPath: string,
  sql: string,
  maxRows: number = config.QUOTA_WIDGET_ROWS,
): Promise<QueryResult> {
  if (!existsSync(duckdbPath)) {
    throw new Error("Workspace database not found; import data first");
  }
  // Views created by register_dataset use paths relative to the workspace root
  // (e.g. `data/x.csv`), so queries must run with that as the working dir.
  // Serialize per database file so widget queries don't collide with the agent.
  const { stdout } = await withDuckdbLock(duckdbPath, () =>
    execFileAsync(
      config.DUCKDB_CLI,
      [duckdbPath, "-readonly", "-json", "-c", sql],
      { cwd: dirname(duckdbPath), maxBuffer: MAX_OUTPUT_BYTES },
    ),
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch {
    throw new Error("DuckDB returned non-JSON output; use a SELECT that returns rows");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Query did not return an array of rows");
  }

  const truncated = parsed.length > maxRows;
  const rows = truncated ? parsed.slice(0, maxRows) : parsed;
  return { rows, truncated, rowCount: parsed.length };
}
