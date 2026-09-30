import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { WorkspacePaths } from "./paths.js";

/**
 * Workspace memory. Content lives on disk (ADR 0002). Growth is bounded by a
 * token budget with simple compaction (ADR 0005) -- no retrieval layer yet.
 *
 * Token estimate is deliberately rough: ~4 chars/token.
 */
const CHARS_PER_TOKEN = 4;

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 8_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export async function readContext(paths: WorkspacePaths): Promise<string> {
  const parts: string[] = [];
  for (const file of [paths.onboardingContext, paths.userNotes]) {
    if (existsSync(file)) {
      parts.push(await readFile(file, "utf8"));
    }
  }
  return parts.join("\n\n");
}

export async function writeOnboardingContext(
  paths: WorkspacePaths,
  markdown: string,
): Promise<void> {
  await writeFile(paths.onboardingContext, markdown, "utf8");
}

export async function appendUserNote(paths: WorkspacePaths, note: string): Promise<void> {
  const header = existsSync(paths.userNotes) ? "" : "# User Notes\n\n";
  await appendFile(paths.userNotes, `${header}${note.trim()}\n`, "utf8");
  await compactIfNeeded(paths);
}

/**
 * If the combined context exceeds the budget, roll the oldest user notes into
 * a compact summary line. This is intentionally lossy and deterministic.
 * TODO: replace with LLM summarisation or retrieval when justified (ADR 0005).
 */
export async function compactIfNeeded(
  paths: WorkspacePaths,
  tokenBudget: number = DEFAULT_CONTEXT_TOKEN_BUDGET,
): Promise<void> {
  const combined = await readContext(paths);
  if (estimateTokens(combined) <= tokenBudget) return;

  const notes = existsSync(paths.userNotes)
    ? await readFile(paths.userNotes, "utf8")
    : "";
  const lines = notes.split("\n");
  const keep = Math.max(0, Math.floor(lines.length / 2));
  const dropped = lines.slice(0, lines.length - keep);
  const kept = lines.slice(lines.length - keep);
  const summary = `<!-- compacted ${dropped.length} older note lines on ${new Date().toISOString()} -->`;
  await writeFile(paths.userNotes, [summary, ...kept].join("\n"), "utf8");
}
