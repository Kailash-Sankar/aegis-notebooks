import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { newId } from "../ids.js";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Notebook, Workspace } from "../types.js";
import type { RegistryProjection } from "../registry/pocketbase.js";
import { currentUser } from "../auth/current-user.js";
import { workspacePaths, type WorkspacePaths } from "./paths.js";
import { compactIfNeeded } from "./context.js";

const WORKSPACE_MANIFEST_VERSION = 1;

interface WorkspaceManifest {
  version: number;
  id: string;
  name: string;
  ownerId: string;
  status: Workspace["status"];
  createdAt: string;
}

interface OnboardingState {
  version: number;
  lastOnboardedAt: string | null;
  dataRevision: string;
  tables: number;
}

interface NotebookManifest {
  version: number;
  id: string;
  workspaceId: string;
  title: string;
  ownerId: string;
  lastActive: string | null;
}

/**
 * Disk is the authority for existence (ADR 0002). The manager writes and reads
 * on-disk manifests and keeps the PocketBase projection in sync, but never
 * depends on PocketBase to answer "does this workspace exist?".
 */
export class WorkspaceManager {
  constructor(
    private readonly config: Config,
    private readonly registry: RegistryProjection,
  ) {}

  rootFor(workspaceId: string): string {
    return join(this.config.workspacesRootAbs, workspaceId);
  }

  pathsFor(workspaceId: string): WorkspacePaths {
    return workspacePaths(this.config.workspacesRootAbs, workspaceId);
  }

  async create(name: string): Promise<Workspace> {
    const id = newId();
    const paths = this.pathsFor(id);
    await mkdir(paths.dataDir, { recursive: true });
    await mkdir(paths.memoryDir, { recursive: true });
    await mkdir(paths.notebooksDir, { recursive: true });

    await writeFile(
      paths.metadataSchema,
      JSON.stringify({ version: 1, tables: {} }, null, 2),
      "utf8",
    );
    await writeFile(
      paths.onboardingContext,
      "# Onboarding Context\n\n_Not yet generated. Upload data to begin._\n",
      "utf8",
    );

    const manifest: WorkspaceManifest = {
      version: WORKSPACE_MANIFEST_VERSION,
      id,
      name,
      ownerId: currentUser().id,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    await writeFile(paths.manifest, JSON.stringify(manifest, null, 2), "utf8");

    const workspace = toWorkspace(manifest, paths.root);
    await this.registry.upsertWorkspace(workspace);
    return workspace;
  }

  /**
   * Recreate a workspace's on-disk scaffold from an authoritative manifest
   * (e.g. a registry entry during restore, ADR 0001). Existing files are left
   * untouched; only missing scaffold is created.
   */
  async ensureFromManifest(meta: Workspace): Promise<Workspace> {
    const paths = this.pathsFor(meta.id);
    await mkdir(paths.dataDir, { recursive: true });
    await mkdir(paths.memoryDir, { recursive: true });
    await mkdir(paths.notebooksDir, { recursive: true });

    if (!existsSync(paths.metadataSchema)) {
      await writeFile(
        paths.metadataSchema,
        JSON.stringify({ version: 1, tables: {} }, null, 2),
        "utf8",
      );
    }
    if (!existsSync(paths.onboardingContext)) {
      await writeFile(
        paths.onboardingContext,
        "# Onboarding Context\n\n_Restored. Ask the agent to inspect the data to regenerate insights._\n",
        "utf8",
      );
    }

    const manifest: WorkspaceManifest = {
      version: WORKSPACE_MANIFEST_VERSION,
      id: meta.id,
      name: meta.name,
      ownerId: meta.ownerId,
      status: meta.status,
      createdAt: meta.createdAt,
    };
    await writeFile(paths.manifest, JSON.stringify(manifest, null, 2), "utf8");

    const workspace = toWorkspace(manifest, paths.root);
    await this.registry.upsertWorkspace(workspace);
    return workspace;
  }

  async get(workspaceId: string): Promise<Workspace | null> {
    const paths = this.pathsFor(workspaceId);
    if (!existsSync(paths.manifest)) return null;
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as WorkspaceManifest;
    return toWorkspace(manifest, paths.root);
  }

  async list(): Promise<Workspace[]> {
    if (!existsSync(this.config.workspacesRootAbs)) return [];
    const entries = await readdir(this.config.workspacesRootAbs, { withFileTypes: true });
    const out: Workspace[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const ws = await this.get(entry.name);
      if (ws) out.push(ws);
    }
    return out;
  }

  async createNotebook(workspaceId: string, title: string): Promise<Notebook> {
    const workspace = await this.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    const id = newId();
    const paths = this.pathsFor(workspaceId);
    const nb = paths.notebook(id);
    await mkdir(nb.assetsDir, { recursive: true });
    await mkdir(nb.reportsDir, { recursive: true });
    await writeFile(nb.chatHistory, "[]", "utf8");
    await writeFile(nb.executionLog, "", "utf8");

    const manifest: NotebookManifest = {
      version: 1,
      id,
      workspaceId,
      title,
      ownerId: currentUser().id,
      lastActive: new Date().toISOString(),
    };
    await writeFile(nb.manifest, JSON.stringify(manifest, null, 2), "utf8");

    const notebook = toNotebook(manifest);
    await this.registry.upsertNotebook(notebook);
    return notebook;
  }

  async getNotebook(workspaceId: string, notebookId: string): Promise<Notebook | null> {
    const nb = this.pathsFor(workspaceId).notebook(notebookId);
    if (!existsSync(nb.manifest)) return null;
    const manifest = JSON.parse(await readFile(nb.manifest, "utf8")) as NotebookManifest;
    return toNotebook(manifest);
  }

  async listNotebooks(workspaceId: string): Promise<Notebook[]> {
    const dir = this.pathsFor(workspaceId).notebooksDir;
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const out: Notebook[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nb = await this.getNotebook(workspaceId, entry.name);
      if (nb) out.push(nb);
    }
    return out;
  }

  /** List raw files in the local working set (data/). Disk is authoritative. */
  async listData(
    workspaceId: string,
  ): Promise<Array<{ name: string; bytes: number; modified: string }>> {
    const dir = this.pathsFor(workspaceId).dataDir;
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const out: Array<{ name: string; bytes: number; modified: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const s = await stat(join(dir, entry.name));
      out.push({ name: entry.name, bytes: s.size, modified: s.mtime.toISOString() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Hash of the current data sources (names + sizes + mtimes). */
  async dataRevision(workspaceId: string): Promise<string> {
    const files = await this.listData(workspaceId);
    const hash = createHash("sha256");
    for (const f of files) hash.update(`${f.name}:${f.bytes}:${f.modified}\n`);
    return hash.digest("hex").slice(0, 16);
  }

  /**
   * Onboarding is workspace-scoped (ADR 0002). Status is derived from the
   * on-disk state file plus the current data revision for staleness.
   */
  async getOnboardingStatus(workspaceId: string): Promise<{
    onboarded: boolean;
    stale: boolean;
    lastOnboardedAt: string | null;
    tables: number;
  }> {
    const paths = this.pathsFor(workspaceId);
    let state: OnboardingState | null = null;
    if (existsSync(paths.onboardingState)) {
      try {
        state = JSON.parse(await readFile(paths.onboardingState, "utf8")) as OnboardingState;
      } catch {
        state = null;
      }
    }
    const revision = await this.dataRevision(workspaceId);
    const tables = await this.countTables(paths.metadataSchema);
    // Onboarded if we recorded a confirmed run, or the workspace predates the
    // state file but already has generated context + tables.
    const recorded = Boolean(state?.lastOnboardedAt);
    const hasContext = await this.contextLooksGenerated(paths.onboardingContext);
    const onboarded = recorded || (tables > 0 && hasContext);
    return {
      onboarded,
      stale: recorded && state?.dataRevision !== revision,
      lastOnboardedAt: state?.lastOnboardedAt ?? null,
      tables,
    };
  }

  /** Record a completed onboarding run against the current data revision. */
  async markOnboarded(workspaceId: string): Promise<void> {
    const paths = this.pathsFor(workspaceId);
    const state: OnboardingState = {
      version: 1,
      lastOnboardedAt: new Date().toISOString(),
      dataRevision: await this.dataRevision(workspaceId),
      tables: await this.countTables(paths.metadataSchema),
    };
    await mkdir(paths.memoryDir, { recursive: true });
    await writeFile(paths.onboardingState, JSON.stringify(state, null, 2), "utf8");
  }

  /**
   * Clear onboarding (conversation, context, and derived views) so the user can
   * start over. Raw uploads are left intact.
   */
  async resetOnboarding(workspaceId: string): Promise<void> {
    const paths = this.pathsFor(workspaceId);
    for (const file of [
      paths.onboardingState,
      paths.onboardingTranscript,
      paths.duckdb,
      `${paths.duckdb}.wal`,
    ]) {
      await rm(file, { force: true });
    }
    await writeFile(
      paths.onboardingContext,
      "# Onboarding Context\n\n_Not yet generated. Run onboarding to begin._\n",
      "utf8",
    );
    await writeFile(
      paths.metadataSchema,
      JSON.stringify({ version: 1, tables: {} }, null, 2),
      "utf8",
    );
  }

  /** Remove the entire workspace directory (context, data, notebooks). */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await rm(this.pathsFor(workspaceId).root, { recursive: true, force: true });
  }

  async readUserNotes(workspaceId: string): Promise<string> {
    const p = this.pathsFor(workspaceId).userNotes;
    return existsSync(p) ? readFile(p, "utf8") : "";
  }

  async writeUserNotes(workspaceId: string, notes: string): Promise<void> {
    const paths = this.pathsFor(workspaceId);
    await mkdir(paths.memoryDir, { recursive: true });
    await writeFile(paths.userNotes, notes, "utf8");
    // Keep the injected context (onboarding_context + user_notes) within the
    // token budget (ADR 0005). Compaction drops the oldest note lines first.
    await compactIfNeeded(paths);
  }

  /** True when onboarding_context.md has been generated (not the placeholder). */
  private async contextLooksGenerated(contextPath: string): Promise<boolean> {
    if (!existsSync(contextPath)) return false;
    try {
      const text = await readFile(contextPath, "utf8");
      return !text.includes("_Not yet generated") && text.trim().length > 80;
    } catch {
      return false;
    }
  }

  private async countTables(schemaPath: string): Promise<number> {
    if (!existsSync(schemaPath)) return 0;
    try {
      const parsed = JSON.parse(await readFile(schemaPath, "utf8")) as {
        tables?: Record<string, unknown>;
      };
      return Object.keys(parsed.tables ?? {}).length;
    } catch {
      return 0;
    }
  }

  /** Resolve and validate a workspace that must exist. */
  async require(workspaceId: string): Promise<Workspace> {
    const ws = await this.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    return ws;
  }
}

function toWorkspace(m: WorkspaceManifest, path: string): Workspace {
  return {
    id: m.id,
    name: m.name,
    path,
    ownerId: m.ownerId,
    status: m.status,
    createdAt: m.createdAt,
  };
}

function toNotebook(m: NotebookManifest): Notebook {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    title: m.title,
    ownerId: m.ownerId,
    lastActive: m.lastActive,
  };
}
