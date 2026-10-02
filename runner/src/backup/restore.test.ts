import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { WorkspaceManager } from "../workspace/manager.js";
import type { RegistryProjection } from "../registry/pocketbase.js";
import type {
  BackupRecord,
  Notebook,
  UploadRecord,
  WidgetSpec,
  Workspace,
} from "../types.js";
import { BackupService } from "./manifest.js";
import { restoreWorkspace } from "./restore.js";
import type { BackupStore } from "./rustfs.js";

class FakeStore implements BackupStore {
  enabled = true;
  objects = new Map<string, Uint8Array>();
  async ensureReady(): Promise<void> {}
  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }
  async get(key: string): Promise<Uint8Array> {
    const v = this.objects.get(key);
    if (!v) throw new Error(`missing ${key}`);
    return v;
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }
}

class FakeRegistry implements RegistryProjection {
  workspaces = new Map<string, Workspace>();
  uploads: UploadRecord[] = [];
  backups: BackupRecord[] = [];
  widgets: WidgetSpec[] = [];
  notebooks: Notebook[] = [];

  async upsertWorkspace(w: Workspace): Promise<void> {
    this.workspaces.set(w.id, w);
  }
  async upsertNotebook(n: Notebook): Promise<void> {
    this.notebooks.push(n);
  }
  async upsertUpload(u: UploadRecord): Promise<void> {
    const i = this.uploads.findIndex((x) => x.id === u.id);
    if (i >= 0) this.uploads[i] = u;
    else this.uploads.push(u);
  }
  async upsertBackup(b: BackupRecord): Promise<void> {
    this.backups.push(b);
  }
  async upsertWidget(w: WidgetSpec): Promise<void> {
    this.widgets.push(w);
  }
  async updateWidgetPosition(): Promise<void> {}
  async getWorkspace(id: string): Promise<Workspace | null> {
    return this.workspaces.get(id) ?? null;
  }
  async deleteWorkspace(id: string): Promise<void> {
    this.workspaces.delete(id);
    this.uploads = this.uploads.filter((u) => u.workspaceId !== id);
    this.backups = this.backups.filter((b) => b.workspaceId !== id);
  }
  async listUploads(id: string): Promise<UploadRecord[]> {
    return this.uploads.filter((u) => u.workspaceId === id);
  }
  async listBackups(id: string): Promise<BackupRecord[]> {
    return this.backups.filter((b) => b.workspaceId === id);
  }
  async listWidgets(id: string): Promise<WidgetSpec[]> {
    return this.widgets.filter((w) => w.notebookId === id);
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "aegis-restore-"));
  const config = loadConfig({ WORKSPACES_ROOT: root });
  const registry = new FakeRegistry();
  const store = new FakeStore();
  const backup = new BackupService(store, registry);
  const workspaces = new WorkspaceManager(config, registry);
  return { root, registry, store, backup, workspaces };
}

const WS_ID = "ws00000000000a";

test("restoreWorkspace rebuilds data/ from the recovery set", async () => {
  const { root, registry, store, backup, workspaces } = await setup();
  registry.workspaces.set(WS_ID, {
    id: WS_ID,
    name: "W",
    path: join(root, WS_ID),
    ownerId: "local",
    status: "active",
    createdAt: "t",
  });
  const upload: UploadRecord = {
    id: "u00000000000a",
    workspaceId: WS_ID,
    filename: "orders.csv",
    relPath: "abc-orders.csv",
    bytes: 3,
    contentHash: "h",
    s3Key: `${WS_ID}/uploads/h.csv`,
    backupStatus: "done",
    createdAt: "t",
  };
  registry.uploads.push(upload);
  await store.put(upload.s3Key!, new TextEncoder().encode("a,b"));

  const result = await restoreWorkspace(workspaces, registry, backup, WS_ID);
  assert.equal(result.uploadsRestored, 1);
  assert.deepEqual(result.uploadsFailed, []);
  assert.equal(
    await readFile(join(root, WS_ID, "data", "abc-orders.csv"), "utf8"),
    "a,b",
  );
  // scaffold + manifest written
  assert.ok(await readFile(join(root, WS_ID, "workspace.json"), "utf8"));
});

test("restoreWorkspace reports uploads that have no backup", async () => {
  const { root, registry, backup, workspaces } = await setup();
  registry.workspaces.set(WS_ID, {
    id: WS_ID,
    name: "W",
    path: join(root, WS_ID),
    ownerId: "local",
    status: "active",
    createdAt: "t",
  });
  registry.uploads.push({
    id: "u2",
    workspaceId: WS_ID,
    filename: "x.csv",
    relPath: "x.csv",
    bytes: 1,
    contentHash: "h2",
    s3Key: null,
    backupStatus: "skipped",
    createdAt: "t",
  });

  const result = await restoreWorkspace(workspaces, registry, backup, WS_ID);
  assert.equal(result.uploadsRestored, 0);
  assert.deepEqual(result.uploadsWithoutBackup, ["u2"]);
});

test("restoreWorkspace throws when the backup store is disabled", async () => {
  const { registry, store, backup, workspaces } = await setup();
  store.enabled = false;
  await assert.rejects(
    () => restoreWorkspace(workspaces, registry, backup, WS_ID),
    /not configured/,
  );
});

test("restoreWorkspace throws when the workspace has no registry entry", async () => {
  const { registry, backup, workspaces } = await setup();
  await assert.rejects(
    () => restoreWorkspace(workspaces, registry, backup, "missing0"),
    /No registry entry/,
  );
});
