import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEntries } from "./session.js";

async function tempFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aegis-sess-"));
  const f = join(dir, "chat_history.json");
  await writeFile(f, contents);
  return f;
}

test("loadEntries returns [] for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aegis-sess-"));
  assert.deepEqual(loadEntries(join(dir, "nope.json")), []);
});

test("loadEntries returns [] for invalid JSON", async () => {
  assert.deepEqual(loadEntries(await tempFile("not json")), []);
});

test("loadEntries returns [] for non-array JSON", async () => {
  assert.deepEqual(loadEntries(await tempFile('{"a":1}')), []);
});

test("loadEntries keeps only objects with a string type", async () => {
  const f = await tempFile(
    JSON.stringify([{ id: "e1", type: "message" }, { noType: true }, "x", null, 42]),
  );
  const entries = loadEntries(f);
  assert.equal(entries.length, 1);
  assert.equal((entries[0] as { id: string }).id, "e1");
});
