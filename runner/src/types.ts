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

export interface BackupRecord {
  id: string;
  workspaceId: string;
  kind: BackupKind;
  s3Key: string;
  size: number;
  createdAt: string;
}

export type WidgetType = "component" | "artifact";

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
