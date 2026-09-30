import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { QuotaError, QuotaService } from "./quota.js";

const config = loadConfig({
  QUOTA_FILE_BYTES: "10",
  QUOTA_TOTAL_BYTES: "25",
  QUOTA_FILE_COUNT: "2",
});
const quota = new QuotaService(config);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aegis-quota-"));
}

test("usage walks nested files and counts bytes/files", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "sub"), { recursive: true });
  await writeFile(join(dir, "a.txt"), "12345");
  await writeFile(join(dir, "sub", "b.txt"), "678");
  const usage = await quota.usage(dir);
  assert.equal(usage.files, 2);
  assert.equal(usage.bytes, 8);
});

test("usage of a missing dir is zero", async () => {
  const dir = await tempDir();
  assert.deepEqual(await quota.usage(join(dir, "nope")), { bytes: 0, files: 0 });
});

test("rejects a file over the per-file cap", async () => {
  const dir = await tempDir();
  await assert.rejects(() => quota.assertUploadAllowed(dir, 11), QuotaError);
});

test("rejects when the total byte cap would be exceeded", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "a.txt"), "12345678"); // 8
  await writeFile(join(dir, "b.txt"), "12345678"); // 8
  await assert.rejects(() => quota.assertUploadAllowed(dir, 10), QuotaError); // 16+10 > 25
});

test("rejects when the file-count cap would be exceeded", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "a.txt"), "1");
  await writeFile(join(dir, "b.txt"), "1");
  await assert.rejects(() => quota.assertUploadAllowed(dir, 1), QuotaError); // 2+1 > 2
});

test("accepts an upload within all caps", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "a.txt"), "1234");
  await quota.assertUploadAllowed(dir, 5); // no throw
});
