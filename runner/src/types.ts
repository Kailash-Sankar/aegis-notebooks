/**
 * Domain types. These map 1:1 to PocketBase collections (schema/pocketbase-collections.json),
 * but content always lives on disk (ADR 0002).
 */

export type WorkspaceStatus = "active" | "archived";

export interface Workspace {
  id: string;
  name: string;
  /** Absolute path to the workspace directory on the local working set. */
  path: string;
  ownerId: string;
  status: WorkspaceStatus;
  createdAt: string;
}

export interface Notebook {
  id: string;
  workspaceId: string;
  title: string;
  ownerId: string;
  lastActive: string | null;
}

export type BackupStatus = "pending" | "done" | "failed" | "skipped";

export interface UploadRecord {
  id: string;
  workspaceId: string;
  filename: string;
  /** Relative path within the workspace data dir. */
  relPath: string;
  bytes: number;
  contentHash: string;
  s3Key: string | null;
  backupStatus: BackupStatus;
  createdAt: string;
}

export type BackupKind = "upload" | "snapshot";

/**
 * A chunk landed in the raw lake (ADR 0007/0008). This manifest is the message
 * that travels the queue (claim check): it points at immutable bytes in
 * RustFS; it never carries the payload itself.
 */
export interface ChunkManifest {
  id: string;
  tenantId: string;
  workspaceId: string;
  source: string;
  dataset: string;
  contractVersion: number;
  schemaFingerprint: string;
  /** Watermark range this chunk represents. */
  sync: { mode: string; from?: string; to?: string };
  /** Object key in the raw store (RustFS). */
  rawKey: string;
  rows: number;
  bytes: number;
  contentHash: string;
  attempt: number;
  createdAt: string;
}

export interface BackupRecord {
  id: string;
  workspaceId: string;
  kind: BackupKind;
  s3Key: string;
  size: number;
  createdAt: string;
}

export type WidgetType = "component" | "artifact";

/**
 * A full-page static report (Tier 1). Metadata lives in `reports/index.json`;
 * the body lives in `reports/<id>.html` (disk is authority, ADR 0002).
 */
export interface ReportMeta {
  id: string;
  notebookId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Report extends ReportMeta {
  html: string;
}

export interface WidgetSpec {
  id: string;
  notebookId: string;
  type: WidgetType;
  spec: Record<string, unknown>;
  position: Record<string, unknown> | null;
  updatedAt: string;
}

/** A JSON-serialisable Pi transcript entry. */
export type Transcript = unknown[];
