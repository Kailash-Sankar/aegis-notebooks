import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteReport, listReports, readReport, writeReport } from "./reports.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aegis-reports-"));
}

test("writeReport creates a report and index entry", async () => {
  const dir = await tempDir();
  const meta = await writeReport(dir, {
    notebookId: "nb1",
    title: "Q3 Review",
    html: "<h1>Q3</h1>",
  });
  assert.ok(meta.id);
  assert.equal(meta.notebookId, "nb1");

  const list = await listReports(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.title, "Q3 Review");

  const report = await readReport(dir, meta.id);
  assert.equal(report?.html, "<h1>Q3</h1>");
});

test("writeReport with an existing id replaces it and keeps createdAt", async () => {
  const dir = await tempDir();
  const first = await writeReport(dir, {
    notebookId: "nb1",
    title: "Draft",
    html: "<p>one</p>",
  });
  await new Promise((r) => setTimeout(r, 5));
  const updated = await writeReport(dir, {
    id: first.id,
    notebookId: "nb1",
    title: "Final",
    html: "<p>two</p>",
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal((await listReports(dir)).length, 1);
  assert.equal((await readReport(dir, first.id))?.html, "<p>two</p>");
});

test("writeReport with an unknown id creates a new report", async () => {
  const dir = await tempDir();
  const meta = await writeReport(dir, {
    id: "customid",
    notebookId: "nb1",
    title: "New",
    html: "<p>x</p>",
  });
  assert.equal(meta.id, "customid");
});

test("concurrent writes do not corrupt the index", async () => {
  const dir = await tempDir();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      writeReport(dir, { notebookId: "nb1", title: `R${i}`, html: `<p>${i}</p>` }),
    ),
  );
  const list = await listReports(dir);
  assert.equal(list.length, 10);
  const raw = await readFile(join(dir, "index.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
});

test("deleteReport removes the body and index entry", async () => {
  const dir = await tempDir();
  const meta = await writeReport(dir, {
    notebookId: "nb1",
    title: "Temp",
    html: "<p>x</p>",
  });
  assert.equal(await deleteReport(dir, meta.id), true);
  assert.equal(await deleteReport(dir, meta.id), false);
  assert.deepEqual(await listReports(dir), []);
  assert.equal(await readReport(dir, meta.id), null);
});

test("listReports tolerates a missing directory and malformed index", async () => {
  assert.deepEqual(await listReports(await tempDir()), []);
});
