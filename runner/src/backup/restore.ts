import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { RegistryProjection } from "../registry/pocketbase.js";
import type { BackupService } from "./manifest.js";

/**
 * Workspace restore (ADR 0001). Rebuilds the local working set from the
 * recovery set alone: the registry holds the manifest, RustFS holds the bytes.
 *
 * Only per-upload recovery is implemented. Workspace snapshots are deferred,
 * so restore currently reconstructs from the original uploads rather than a
 * point-in-time snapshot.
 */
export interface RestoreResult {
  workspaceId: string;
  uploadsRestored: number;
  uploadsFailed: string[];
  uploadsWithoutBackup: string[];
}

export async function restoreWorkspace(
  workspaces: WorkspaceManager,
  registry: RegistryProjection,
  backup: BackupService,
  workspaceId: string,
): Promise<RestoreResult> {
  if (!backup.enabled) {
    throw new Error("Backup store is not configured (RUSTFS_* unset); cannot restore");
  }

  const meta = await registry.getWorkspace(workspaceId);
  if (!meta) {
    throw new Error(`No registry entry for workspace ${workspaceId}; nothing to restore from`);
  }

  await workspaces.ensureFromManifest(meta);
  const paths = workspaces.pathsFor(workspaceId);

  const uploads = await registry.listUploads(workspaceId);
  const result: RestoreResult = {
    workspaceId,
    uploadsRestored: 0,
    uploadsFailed: [],
    uploadsWithoutBackup: [],
  };

  for (const upload of uploads) {
    if (!upload.s3Key) {
      result.uploadsWithoutBackup.push(upload.id);
      continue;
    }
    try {
      const bytes = await backup.restoreUpload(upload);
      const absPath = join(paths.dataDir, upload.relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, bytes);
      // Refresh the projection so backup_status reflects the recovered copy.
      await registry.upsertUpload(upload);
      result.uploadsRestored++;
    } catch (err) {
      console.error(`[restore] upload ${upload.id} failed:`, err);
      result.uploadsFailed.push(upload.id);
    }
  }

  return result;
}
