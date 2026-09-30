import { useCallback, useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  createNotebook,
  createWorkspace,
  deleteWorkspace,
  getContext,
  listData,
  listNotebooks,
  listWorkspaces,
  restoreWorkspace,
  saveNotes,
} from "./api.js";
import type { DataFile, Notebook, Workspace, WorkspaceContext } from "./types.js";
import { Sidebar } from "./components/Sidebar.js";
import { UploadDialog } from "./components/UploadDialog.js";
import { EmptyState } from "./components/EmptyState.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { Canvas } from "./components/Canvas.js";
import { WorkspaceView } from "./components/WorkspaceView.js";

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [dataFiles, setDataFiles] = useState<DataFile[]>([]);
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pending, setPending] = useState<{ prompt: string; label: string } | null>(
    null,
  );

  const canCreateNotebook = context?.status.onboarded === true;
  const workspaceName =
    workspaces.find((w) => w.id === workspaceId)?.name ?? "Workspace";

  const loadWorkspaces = useCallback(async () => {
    try {
      const list = await listWorkspaces();
      setWorkspaces(list);
      setWorkspaceId((current) => current ?? list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const loadData = useCallback(async (wsId: string) => {
    try {
      setDataFiles(await listData(wsId));
    } catch {
      setDataFiles([]);
    }
  }, []);

  const loadContext = useCallback(async (wsId: string) => {
    try {
      setContext(await getContext(wsId));
    } catch {
      setContext(null);
    }
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setNotebooks([]);
      setNotebookId(null);
      setDataFiles([]);
      setContext(null);
      return;
    }
    setNotebookId(null);
    void loadData(workspaceId);
    void loadContext(workspaceId);
    listNotebooks(workspaceId)
      .then((list) => {
        setNotebooks(list);
        setNotebookId(list[0]?.id ?? null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [workspaceId, loadData, loadContext]);

  async function onCreateWorkspace() {
    const name = window.prompt("Workspace name");
    if (!name) return;
    try {
      const ws = await createWorkspace(name);
      setWorkspaces((prev) => [...prev, ws]);
      setWorkspaceId(ws.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const STARTER_PROMPT =
    "Build a starter dashboard for this workspace. Review the registered views " +
    "and workspace context — if it lists suggested analyses, use them — and " +
    "create 2-4 component widgets (live charts) on the canvas covering the " +
    "most useful analyses.";

  async function onCreateNotebook(opts: {
    starter?: boolean;
    prompt?: string;
    title?: string;
  } = {}) {
    if (!workspaceId) return;
    const title = opts.title ?? window.prompt("Notebook title") ?? "Untitled";
    try {
      const nb = await createNotebook(workspaceId, title);
      setNotebooks((prev) => [...prev, nb]);
      setNotebookId(nb.id);
      if (opts.starter) {
        setPending({ prompt: STARTER_PROMPT, label: "Build a starter dashboard" });
      } else if (opts.prompt) {
        setPending({ prompt: opts.prompt, label: opts.title ?? "Analyze" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onUploaded() {
    if (!workspaceId) return;
    await Promise.all([loadData(workspaceId), loadContext(workspaceId)]);
    setRefreshToken((n) => n + 1);
  }

  const onContextChanged = useCallback(async () => {
    if (!workspaceId) return;
    await loadContext(workspaceId);
    try {
      setNotebooks(await listNotebooks(workspaceId));
    } catch {
      // ignore
    }
  }, [workspaceId, loadContext]);

  async function onSaveNotes(notes: string) {
    if (!workspaceId) return;
    await saveNotes(workspaceId, notes);
    await loadContext(workspaceId);
  }

  async function onRestore() {
    if (!workspaceId) return;
    setError(null);
    setNotice(null);
    try {
      const result = await restoreWorkspace(workspaceId);
      setNotice(
        `Restored ${result.uploadsRestored} upload(s). ` +
          `${result.uploadsWithoutBackup.length} without backup, ` +
          `${result.uploadsFailed.length} failed.`,
      );
      await loadData(workspaceId);
      setRefreshToken((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDeleteWorkspace() {
    if (!workspaceId) return;
    await deleteWorkspace(workspaceId);
    setNotebookId(null);
    setContext(null);
    const list = await listWorkspaces();
    setWorkspaces(list);
    setWorkspaceId(list[0]?.id ?? null);
  }

  return (
    <div className="aegis-app">
      <div className="aegis-workspace">
        <Sidebar
          workspaces={workspaces}
          workspaceId={workspaceId}
          onSelectWorkspace={setWorkspaceId}
          onCreateWorkspace={onCreateWorkspace}
          notebooks={notebooks}
          notebookId={notebookId}
          onSelectNotebook={(id) => setNotebookId(id || null)}
          onCreateNotebook={onCreateNotebook}
          dataFiles={dataFiles}
          canCreateNotebook={canCreateNotebook}
          isWorkspaceView={!notebookId}
          onSelectWorkspaceView={() => setNotebookId(null)}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />

        <div className="aegis-main">
          {(error || notice) && (
            <div className="aegis-banner-area">
              {error ? (
                <Banner
                  status="error"
                  title={error}
                  isDismissable
                  onDismiss={() => setError(null)}
                />
              ) : notice ? (
                <Banner
                  status="success"
                  title={notice}
                  isDismissable
                  onDismiss={() => setNotice(null)}
                />
              ) : null}
            </div>
          )}

          {notebookId && context?.status.stale && (
            <div className="aegis-banner-area">
              <Banner
                status="warning"
                title="New data — refresh workspace context"
                description="Onboarding ran before the latest upload(s). Refresh it so the agent sees the new tables."
                endContent={
                  <Button
                    label="Open workspace overview"
                    variant="secondary"
                    size="sm"
                    onClick={() => setNotebookId(null)}
                  />
                }
              />
            </div>
          )}

          <div className="aegis-content">
            {!workspaceId ? (
              <div className="aegis-pane aegis-pane--canvas">
                <EmptyState needsNotebook={false} />
              </div>
            ) : notebookId ? (
              <>
                <div className="aegis-pane aegis-pane--chat">
                  <ChatPanel
                    workspaceId={workspaceId}
                    notebookId={notebookId}
                    onRunComplete={() => setRefreshToken((n) => n + 1)}
                    initialPrompt={pending?.prompt}
                    initialLabel={pending?.label}
                    onInitialPromptConsumed={() => setPending(null)}
                  />
                </div>
                <div className="aegis-pane aegis-pane--canvas">
                  <Canvas
                    workspaceId={workspaceId}
                    notebookId={notebookId}
                    refreshToken={refreshToken}
                  />
                </div>
              </>
            ) : (
              <WorkspaceView
                workspaceId={workspaceId}
                workspaceName={workspaceName}
                dataFiles={dataFiles}
                context={context}
                onOpenUpload={() => setUploadOpen(true)}
                onSaveNotes={onSaveNotes}
                onCreateNotebook={onCreateNotebook}
                onRestore={onRestore}
                onDelete={onDeleteWorkspace}
                onContextChanged={onContextChanged}
                hasNotebooks={notebooks.length > 0}
              />
            )}
          </div>
        </div>
      </div>

      {workspaceId && (
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          workspaceId={workspaceId}
          existing={dataFiles}
          onUploaded={onUploaded}
        />
      )}
    </div>
  );
}
