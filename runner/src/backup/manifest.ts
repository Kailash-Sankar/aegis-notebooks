import { readFile } from "node:fs/promises";
import { newId } from "../ids.js";
import { extname } from "node:path";
import type { BackupRecord, UploadRecord } from "../types.js";
import type { RegistryProjection } from "../registry/pocketbase.js";
import type { BackupStore } from "./rustfs.js";

/**
 * Writes the backup manifest and moves bytes to the recovery set. The
 * manifest lives in PocketBase (uploads.s3_key / backup_status) so restore
 * never depends on the local disk (ADR 0001).
 */
export class BackupService {
  constructor(
    private readonly store: BackupStore,
    private readonly registry: RegistryProjection,
  ) {}

  get enabled(): boolean {
    return this.store.enabled;
  }

  /** Ensure the recovery set is reachable and its bucket exists. */
  async ensureReady(): Promise<void> {
    await this.store.ensureReady();
  }

  /** Delete every backup object for a workspace. */
  async deleteWorkspaceBackups(workspaceId: string): Promise<void> {
    if (!this.store.enabled) return;
    await this.store.deletePrefix(`${workspaceId}/`);
  }

  uploadKey(workspaceId: string, record: Pick<UploadRecord, "contentHash" | "filename">): string {
    const ext = extname(record.filename).replace(/^\./, "");
    const suffix = ext ? `.${ext}` : "";
    return `${workspaceId}/uploads/${record.contentHash}${suffix}`;
  }

  /**
   * Copy an uploaded file to RustFS and persist the manifest. Mutates and
   * re-projects the upload record's backup status. Never throws on backup
   * failure -- the local working set is unaffected (ADR 0001).
   */
  async backupUpload(
    workspaceId: string,
    upload: UploadRecord,
    absPath: string,
  ): Promise<void> {
    if (!this.store.enabled) {
      upload.backupStatus = "skipped";
      await this.registry.upsertUpload(upload);
      return;
    }

    upload.backupStatus = "pending";
    await this.registry.upsertUpload(upload);

    try {
      const bytes = await readFile(absPath);
      const key = this.uploadKey(workspaceId, upload);
      await this.store.put(key, bytes);

      const record: BackupRecord = {
        id: newId(),
        workspaceId,
        kind: "upload",
        s3Key: key,
        size: bytes.byteLength,
        createdAt: new Date().toISOString(),
      };
      await this.registry.upsertBackup(record);

      upload.s3Key = key;
      upload.backupStatus = "done";
      await this.registry.upsertUpload(upload);
    } catch (err) {
      upload.backupStatus = "failed";
      await this.registry.upsertUpload(upload);
      console.error(`[backup] upload ${upload.id} failed:`, err);
    }
  }

  /** Recovery path: rebuild an upload from RustFS alone. */
  async restoreUpload(upload: UploadRecord): Promise<Uint8Array> {
    if (!upload.s3Key) {
      throw new Error(`Upload ${upload.id} has no s3_key; cannot restore`);
    }
    return this.store.get(upload.s3Key);
  }
}
