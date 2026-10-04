import type { SourceContract } from "./contract.js";

/**
 * Contract drift: compare the columns a source currently exposes with the
 * columns the contract declares. Additive drift (`added`) is auto-applied by
 * `ADD COLUMN IF NOT EXISTS`; removals and type changes need review.
 */
export interface ColumnDiff {
  added: string[];
  removed: string[];
  drifted: boolean;
}

export function diffColumns(
  contract: SourceContract,
  discovered: Array<{ name: string }>,
): ColumnDiff {
  const declared = new Set(Object.keys(contract.columns));
  const seen = new Set(discovered.map((c) => c.name));
  const added = [...seen].filter((n) => !declared.has(n)).sort();
  const removed = [...declared].filter((n) => !seen.has(n)).sort();
  return { added, removed, drifted: added.length > 0 || removed.length > 0 };
}
