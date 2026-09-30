import { createHash } from "node:crypto";
import { newId } from "../ids.js";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { UploadRecord } from "../types.js";
import type { RegistryProjection } from "../registry/pocketbase.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { BackupService } from "../backup/manifest.js";
import type { QuotaService } from "./quota.js";

export interface IngestDeps {
  workspaces: WorkspaceManager;
  registry: RegistryProjection;
  backup: BackupService;
  quota: QuotaService;
}

/**
 * Ingestion: validate caps -> write to the local working set -> project to
 * PocketBase -> copy to the recovery set asynchronously (ADR 0001/0002/0005).
 * Returns once the file is queryable on local disk; backup happens in the
 * background and never blocks ingestion.
 */
export async function ingestUpload(
  deps: IngestDeps,
  workspaceId: string,
  filename: string,
  data: Uint8Array,
): Promise<UploadRecord> {
  const workspace = await deps.workspaces.require(workspaceId);
  const paths = deps.workspaces.pathsFor(workspaceId);

  await deps.quota.assertUploadAllowed(paths.dataDir, data.byteLength);

  const contentHash = createHash("sha256").update(data).digest("hex");
  const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const relPath = `${contentHash.slice(0, 12)}-${safeName}`;
  const absPath = join(paths.dataDir, relPath);
  await writeFile(absPath, data);

  const record: UploadRecord = {
    id: newId(),
    workspaceId,
    filename: safeName,
    relPath,
    bytes: data.byteLength,
    contentHash,
    s3Key: null,
    backupStatus: deps.backup.enabled ? "pending" : "skipped",
    createdAt: new Date().toISOString(),
  };

  await deps.registry.upsertUpload(record);

  // Fire-and-forget: recovery set is not on the query path.
  void deps.backup.backupUpload(workspaceId, record, absPath);

  // Touch the workspace so the projection reflects activity.
  await deps.registry.upsertWorkspace(workspace);
  return record;
}
