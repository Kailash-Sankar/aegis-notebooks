import type { RegistryProjection } from "./pocketbase.js";
import type { WorkspaceManager } from "../workspace/manager.js";

/**
 * Disk is authoritative (ADR 0002). Reconciliation scans the filesystem and
 * repairs the PocketBase projection. It never deletes or rewrites disk content
 * based on registry state -- only the reverse.
 *
 * Run once at startup. TODO: also add a periodic/lazy reconcile.
 */
export async function reconcile(
  workspaces: WorkspaceManager,
  registry: RegistryProjection,
): Promise<{ workspaces: number; notebooks: number }> {
  let workspaceCount = 0;
  let notebookCount = 0;

  for (const workspace of await workspaces.list()) {
    await registry.upsertWorkspace(workspace);
    workspaceCount++;
    for (const notebook of await workspaces.listNotebooks(workspace.id)) {
      await registry.upsertNotebook(notebook);
      notebookCount++;
    }
  }

  return { workspaces: workspaceCount, notebooks: notebookCount };
}
