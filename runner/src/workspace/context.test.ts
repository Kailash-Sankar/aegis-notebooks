import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths, type WorkspacePaths } from "./paths.js";
import { appendUserNote, compactIfNeeded, estimateTokens, readContext } from "./context.js";

async function makePaths(): Promise<WorkspacePaths> {
  const root = await mkdtemp(join(tmpdir(), "aegis-ctx-"));
  const p = workspacePaths(root, "ws");
  await mkdir(p.memoryDir, { recursive: true });
  await writeFile(p.onboardingContext, "# ctx\nhello world");
  await writeFile(p.userNotes, "# User Notes\n\nnote one\n");
  return p;
}

test("estimateTokens is ~chars/4 (rounded up)", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("readContext merges onboarding and user notes", async () => {
  const p = await makePaths();
  const ctx = await readContext(p);
  assert.match(ctx, /hello world/);
  assert.match(ctx, /note one/);
});

test("appendUserNote keeps content within the token budget by compacting", async () => {
  const p = await makePaths();
  const big = Array.from({ length: 400 }, (_, i) => `line ${i} `.repeat(20)).join("\n");
  await writeFile(p.userNotes, big);
  await compactIfNeeded(p, 100);
  const after = await readFile(p.userNotes, "utf8");
  assert.ok(after.length < big.length, "notes should shrink");
  assert.match(after, /compacted/);
});

test("appendUserNote appends to user notes", async () => {
  const p = await makePaths();
  await appendUserNote(p, "user says column amount is USD cents");
  const after = await readFile(p.userNotes, "utf8");
  assert.match(after, /amount is USD cents/);
  assert.match(after, /note one/);
});
