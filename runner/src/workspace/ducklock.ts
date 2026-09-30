/**
 * Per-database mutex for DuckDB CLI invocations.
 *
 * DuckDB takes an exclusive lock on a database file, and each of our tools
 * spawns a separate `duckdb` process. Pi can issue tool calls in parallel, so
 * two processes would open the same file at once and fail with "Could not set
 * lock on file". Serializing per database path avoids that.
 */
const chains = new Map<string, Promise<unknown>>();

export function withDuckdbLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Keep the chain alive but never let a rejection poison the queue.
  chains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
