import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeSecretResolver,
  readCredentials,
  writeCredentials,
} from "./secrets.js";

test("credentials round-trip and resolve with env precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aegis-secrets-"));
  const path = join(dir, "credentials.json");
  try {
    await writeCredentials(path, { TOKEN: "file-token" });
    assert.deepEqual(await readCredentials(path), { TOKEN: "file-token" });

    const fromEnv = makeSecretResolver({ TOKEN: "file-token" }, {
      TOKEN: "env-token",
    } as NodeJS.ProcessEnv);
    assert.equal(fromEnv("TOKEN"), "env-token");

    const fromFile = makeSecretResolver({ TOKEN: "file-token" }, {} as NodeJS.ProcessEnv);
    assert.equal(fromFile("TOKEN"), "file-token");
    assert.equal(fromFile("MISSING"), undefined);

    assert.deepEqual(await readCredentials(join(dir, "nope.json")), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
