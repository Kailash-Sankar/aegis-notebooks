import type { Config } from "../config.js";
import type {
  BackupRecord,
  BackupStatus,
  Notebook,
  UploadRecord,
  WidgetSpec,
  Workspace,
} from "../types.js";

/**
 * PocketBase is a projection of disk state (ADR 0002). Nothing here is the
 * authority for existence; see registry/reconcile.ts. All methods are
 * "upsert by domain id" so re-running after a crash is safe.
 */
export interface RegistryProjection {
  upsertWorkspace(w: Workspace): Promise<void>;
  upsertNotebook(n: Notebook): Promise<void>;
  upsertUpload(u: UploadRecord): Promise<void>;
  upsertBackup(b: BackupRecord): Promise<void>;
  upsertWidget(w: WidgetSpec): Promise<void>;
  /** Persist a widget's canvas placement (drag/resize). */
  updateWidgetPosition(
    widgetId: string,
    position: Record<string, unknown>,
  ): Promise<void>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  /** Remove every registry record belonging to a workspace. */
  deleteWorkspace(workspaceId: string): Promise<void>;
  listUploads(workspaceId: string): Promise<UploadRecord[]>;
  listBackups(workspaceId: string): Promise<BackupRecord[]>;
  listWidgets(notebookId: string): Promise<WidgetSpec[]>;
}

/** No-op registry used when PocketBase is not configured. */
export class NullRegistry implements RegistryProjection {
  async upsertWorkspace(): Promise<void> {}
  async upsertNotebook(): Promise<void> {}
  async upsertUpload(): Promise<void> {}
  async upsertBackup(): Promise<void> {}
  async upsertWidget(): Promise<void> {}
  async updateWidgetPosition(): Promise<void> {}
  async getWorkspace(): Promise<Workspace | null> {
    return null;
  }
  async deleteWorkspace(): Promise<void> {}
  async listUploads(): Promise<UploadRecord[]> {
    return [];
  }
  async listBackups(): Promise<BackupRecord[]> {
    return [];
  }
  async listWidgets(): Promise<WidgetSpec[]> {
    return [];
  }
}

type PBRecord = Record<string, unknown> & { id: string };

export class PocketBaseRegistry implements RegistryProjection {
  private token: string | null = null;

  constructor(private readonly config: Config) {}

  private async authenticate(): Promise<string> {
    if (this.token) return this.token;
    // PocketBase renamed the admin collection to `_superusers` in newer
    // releases. Try the current path first, then the legacy one.
    const paths = [
      "/api/collections/_superusers/auth-with-password",
      "/api/admins/auth-with-password",
    ];
    let lastError = "unknown";
    for (const path of paths) {
      const res = await fetch(`${this.config.POCKETBASE_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identity: this.config.POCKETBASE_ADMIN_EMAIL,
          password: this.config.POCKETBASE_ADMIN_PASSWORD,
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { token: string };
        this.token = body.token;
        return this.token;
      }
      lastError = `${res.status} ${await res.text()}`;
    }
    throw new Error(`PocketBase auth failed: ${lastError}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.authenticate();
    const res = await fetch(`${this.config.POCKETBASE_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PocketBase ${method} ${path} -> ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async remove(collection: string, id: string): Promise<void> {
    await this.request("DELETE", `/api/collections/${collection}/records/${id}`);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const notebooks = await this.list<PBRecord>(
      "notebooks",
      `workspace_id='${workspaceId}'`,
    );
    for (const nb of notebooks) {
      const widgets = await this.list<PBRecord>(
        "widget_specs",
        `notebook_id='${nb.id}'`,
      );
      for (const w of widgets) await this.remove("widget_specs", w.id);
    }
    for (const collection of ["notebooks", "uploads", "backups"]) {
      const rows = await this.list<PBRecord>(
        collection,
        `workspace_id='${workspaceId}'`,
      );
      for (const row of rows) await this.remove(collection, row.id);
    }
    try {
      await this.remove("workspaces", workspaceId);
    } catch {
      // already gone
    }
  }

  /** Create-or-update keyed by the domain id (used as the PB record id). */
  private async upsert(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.request("PATCH", `/api/collections/${collection}/records/${id}`, data);
    } catch {
      await this.request("POST", `/api/collections/${collection}/records`, { id, ...data });
    }
  }

  async upsertWorkspace(w: Workspace): Promise<void> {
    await this.upsert("workspaces", w.id, {
      name: w.name,
      path: w.path,
      owner_id: w.ownerId,
      status: w.status,
      created_at: w.createdAt,
    });
  }

  async upsertNotebook(n: Notebook): Promise<void> {
    await this.upsert("notebooks", n.id, {
      workspace_id: n.workspaceId,
      title: n.title,
      owner_id: n.ownerId,
      last_active: n.lastActive,
    });
  }

  async upsertUpload(u: UploadRecord): Promise<void> {
    await this.upsert("uploads", u.id, {
      workspace_id: u.workspaceId,
      filename: u.filename,
      rel_path: u.relPath,
      bytes: u.bytes,
      content_hash: u.contentHash,
      s3_key: u.s3Key,
      backup_status: u.backupStatus,
      created_at: u.createdAt,
    });
  }

  async upsertBackup(b: BackupRecord): Promise<void> {
    await this.upsert("backups", b.id, {
      workspace_id: b.workspaceId,
      kind: b.kind,
      s3_key: b.s3Key,
      size: b.size,
      created_at: b.createdAt,
    });
  }

  async upsertWidget(w: WidgetSpec): Promise<void> {
    await this.upsert("widget_specs", w.id, {
      notebook_id: w.notebookId,
      type: w.type,
      spec: w.spec,
      position: w.position,
      updated_at: w.updatedAt,
    });
  }

  async updateWidgetPosition(
    widgetId: string,
    position: Record<string, unknown>,
  ): Promise<void> {
    await this.request("PATCH", `/api/collections/widget_specs/records/${widgetId}`, {
      position,
      updated_at: new Date().toISOString(),
    });
  }

  private async list<T>(collection: string, filter: string): Promise<T[]> {
    const q = encodeURIComponent(filter);
    const body = await this.request<{ items: T[] }>(
      "GET",
      `/api/collections/${collection}/records?perPage=500&filter=${q}`,
    );
    return body.items;
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    try {
      const row = await this.request<PBRecord>(
        "GET",
        `/api/collections/workspaces/records/${workspaceId}`,
      );
      return mapWorkspaceRow(row);
    } catch {
      return null;
    }
  }

  async listUploads(workspaceId: string): Promise<UploadRecord[]> {
    const rows = await this.list<PBRecord>("uploads", `workspace_id='${workspaceId}'`);
    return rows.map(mapUploadRow);
  }

  async listBackups(workspaceId: string): Promise<BackupRecord[]> {
    const rows = await this.list<PBRecord>("backups", `workspace_id='${workspaceId}'`);
    return rows.map(mapBackupRow);
  }

  async listWidgets(notebookId: string): Promise<WidgetSpec[]> {
    const rows = await this.list<PBRecord>("widget_specs", `notebook_id='${notebookId}'`);
    return rows.map(mapWidgetRow);
  }
}

// --- Row mappers -----------------------------------------------------------
// PocketBase stores snake_case fields as declared in
// schema/pocketbase-collections.json. These convert rows to domain types so
// callers never see the persistence shape.

export function mapWorkspaceRow(row: PBRecord): Workspace {
  return {
    id: row.id,
    name: asString(row.name),
    path: asString(row.path),
    ownerId: asString(row.owner_id),
    status: (row.status === "archived" ? "archived" : "active") as Workspace["status"],
    createdAt: asString(row.created_at),
  };
}

export function mapUploadRow(row: PBRecord): UploadRecord {
  return {
    id: row.id,
    workspaceId: asString(row.workspace_id),
    filename: asString(row.filename),
    relPath: asString(row.rel_path),
    bytes: asNumber(row.bytes),
    contentHash: asString(row.content_hash),
    s3Key: row.s3_key == null ? null : asString(row.s3_key),
    backupStatus: asBackupStatus(row.backup_status),
    createdAt: asString(row.created_at),
  };
}

export function mapBackupRow(row: PBRecord): BackupRecord {
  return {
    id: row.id,
    workspaceId: asString(row.workspace_id),
    kind: row.kind === "snapshot" ? "snapshot" : "upload",
    s3Key: asString(row.s3_key),
    size: asNumber(row.size),
    createdAt: asString(row.created_at),
  };
}

export function mapWidgetRow(row: PBRecord): WidgetSpec {
  return {
    id: row.id,
    notebookId: asString(row.notebook_id),
    type: row.type === "artifact" ? "artifact" : "component",
    spec: (row.spec as Record<string, unknown> | undefined) ?? {},
    position: (row.position as Record<string, unknown> | undefined) ?? null,
    updatedAt: asString(row.updated_at),
  };
}

function asString(v: unknown): string {
  return v == null ? "" : String(v);
}

function asNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asBackupStatus(v: unknown): BackupStatus {
  switch (v) {
    case "pending":
    case "done":
    case "failed":
    case "skipped":
      return v;
    default:
      return "pending";
  }
}

export function createRegistry(config: Config): RegistryProjection {
  return config.registryEnabled ? new PocketBaseRegistry(config) : new NullRegistry();
}

/** Re-exported so callers can type PB rows without importing the SDK. */
export type { PBRecord };
