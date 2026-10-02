import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Durable connector progress for one source (design §5):
 * `sources/{source}/state.json`.
 *
 * `watermark` is the authoritative resume point across runs (the max value of
 * the contract's `cursorField` we have landed). `cursor` is only meaningful
 * within a run. Re-reading from `watermark` is always safe because landing is
 * idempotent (content-addressed raw + engine-level dedupe).
 */
export interface ConnectorState {
  /** Last cursor within a run (ephemeral; null between runs). */
  cursor: string | null;
  /** Max incremental watermark landed so far. */
  watermark: string | null;
  /** When this state was last written. */
  updatedAt: string | null;
}

export const EMPTY_STATE: ConnectorState = {
  cursor: null,
  watermark: null,
  updatedAt: null,
};

export async function readState(path: string): Promise<ConnectorState> {
  if (!existsSync(path)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ConnectorState>;
    return {
      cursor: typeof parsed.cursor === "string" ? parsed.cursor : null,
      watermark: typeof parsed.watermark === "string" ? parsed.watermark : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function writeState(
  path: string,
  state: ConnectorState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}
