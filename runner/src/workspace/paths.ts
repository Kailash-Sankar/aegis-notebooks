import { join } from "node:path";

/**
 * The workspace directory contract (see docs/architecture.md). This is the
 * interface between the runner, the agent, and any future service. Keep it
 * stable.
 *
 *   /workspaces/{workspace_id}/
 *   ├── workspace.json          # on-disk manifest (authority for existence)
 *   ├── workspace.duckdb
 *   ├── data/                   # raw uploads = the local working set
 *   ├── memory/
 *   │   ├── metadata_schema.json
 *   │   ├── onboarding_context.md
 *   │   └── user_notes.md
 *   └── notebooks/{notebook_id}/
 *       ├── notebook.json
 *       ├── chat_history.json
 *       ├── execution.log
 *       └── generated_assets/
 */
export interface WorkspacePaths {
  root: string;
  manifest: string;
  duckdb: string;
  dataDir: string;
  memoryDir: string;
  metadataSchema: string;
  onboardingContext: string;
  userNotes: string;
  /** Workspace-scoped onboarding state + transcript (not a notebook). */
  onboardingState: string;
  onboardingTranscript: string;
  notebooksDir: string;
  notebook(notebookId: string): NotebookPaths;
}

export interface NotebookPaths {
  root: string;
  manifest: string;
  chatHistory: string;
  executionLog: string;
  assetsDir: string;
}

export function workspacePaths(rootAbs: string, workspaceId: string): WorkspacePaths {
  const root = join(rootAbs, workspaceId);
  return {
    root,
    manifest: join(root, "workspace.json"),
    duckdb: join(root, "workspace.duckdb"),
    dataDir: join(root, "data"),
    memoryDir: join(root, "memory"),
    metadataSchema: join(root, "memory", "metadata_schema.json"),
    onboardingContext: join(root, "memory", "onboarding_context.md"),
    userNotes: join(root, "memory", "user_notes.md"),
    onboardingState: join(root, "memory", "onboarding.json"),
    onboardingTranscript: join(root, "memory", "onboarding_transcript.json"),
    notebooksDir: join(root, "notebooks"),
    notebook(notebookId: string): NotebookPaths {
      const nb = join(root, "notebooks", notebookId);
      return {
        root: nb,
        manifest: join(nb, "notebook.json"),
        chatHistory: join(nb, "chat_history.json"),
        executionLog: join(nb, "execution.log"),
        assetsDir: join(nb, "generated_assets"),
      };
    },
  };
}
