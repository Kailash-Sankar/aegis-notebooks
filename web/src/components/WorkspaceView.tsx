import { useEffect, useState } from "react";
import {
  Database,
  FileText,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import {
  getOnboardTranscript,
  resetOnboarding,
  streamOnboard,
  streamOnboardChat,
} from "../api.js";
import { transcriptToMessages } from "../transcript.js";
import type { ChatMessage, DataFile, WorkspaceContext } from "../types.js";
import { AgentChat, appendAssistantDelta } from "./AgentChat.js";

/**
 * Workspace view: onboarding is a conversation (left), and the context it
 * builds (right). The agent asks clarifying questions; answers refine the
 * workspace memory that every notebook shares.
 */
export function WorkspaceView({
  workspaceId,
  workspaceName,
  dataFiles,
  context,
  onOpenUpload,
  onSaveNotes,
  onCreateNotebook,
  onRestore,
  onDelete,
  onContextChanged,
  hasNotebooks,
}: {
  workspaceId: string;
  workspaceName: string;
  dataFiles: DataFile[];
  context: WorkspaceContext | null;
  onOpenUpload: () => void;
  onSaveNotes: (notes: string) => Promise<void>;
  onCreateNotebook: (opts?: {
    starter?: boolean;
    prompt?: string;
    title?: string;
  }) => void;
  onRestore: () => void;
  onDelete: () => Promise<void>;
  onContextChanged: () => Promise<void>;
  hasNotebooks: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const status = context?.status;
  const onboarded = Boolean(status?.onboarded);
  const stale = Boolean(status?.stale);
  const hasData = dataFiles.length > 0;

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    getOnboardTranscript(workspaceId)
      .then((entries) => {
        if (!cancelled) setMessages(transcriptToMessages(entries));
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  /** Run onboarding, or continue the conversation if a prompt is given. */
  async function run(prompt?: string) {
    if (busy) return;
    setError(null);
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: prompt ?? "Onboard this workspace" },
      { role: "assistant", text: "" },
    ]);
    try {
      const onDelta = (delta: string) => appendAssistantDelta(setMessages, delta);
      if (prompt) await streamOnboardChat(workspaceId, prompt, onDelta);
      else await streamOnboard(workspaceId, onDelta);
      await onContextChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (
      !window.confirm(
        "Reset onboarding? This clears the onboarding conversation and generated context. Raw data is kept.",
      )
    ) {
      return;
    }
    setError(null);
    await resetOnboarding(workspaceId);
    setMessages([]);
    await onContextChanged();
  }

  return (
    <>
      {/* Left: onboarding conversation */}
      <div className="aegis-pane aegis-pane--chat">
        <Stack direction="vertical" height="100%">
          <div className="aegis-pane-header">
            <Text type="label" color="secondary">
              Onboarding
            </Text>
            <Stack direction="horizontal" gap={1}>
              <IconButton
                label="Upload data"
                tooltip="Upload data"
                variant="ghost"
                size="sm"
                icon={<Upload size={15} />}
                onClick={onOpenUpload}
              />
              <IconButton
                label="Re-run onboarding"
                tooltip="Re-run onboarding"
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={15} />}
                onClick={() => run()}
                isDisabled={busy || !hasData}
              />
              <IconButton
                label="Reset onboarding"
                tooltip="Reset onboarding"
                variant="ghost"
                size="sm"
                icon={<RotateCcw size={15} />}
                onClick={reset}
                isDisabled={busy}
              />
            </Stack>
          </div>

          {messages.length === 0 && !busy ? (
            <Center axis="both" width="100%" height="100%" padding={6}>
              <Stack gap={3} maxWidth={340}>
                <Text weight="semibold">
                  {onboarded ? "Refresh workspace context" : "Onboard this workspace"}
                </Text>
                <Text type="supporting" color="secondary">
                  The agent profiles each data file and creates DuckDB views,
                  then summarizes what it found and asks clarifying questions.
                  Answer them — it saves the workspace context once you confirm.
                </Text>
                <Button
                  label={onboarded ? "Re-run onboarding" : "Start onboarding"}
                  variant="primary"
                  icon={<Sparkles size={15} />}
                  isDisabled={!hasData}
                  onClick={() => run()}
                />
                {!hasData && (
                  <Text type="supporting" color="secondary">
                    Upload data first.
                  </Text>
                )}
              </Stack>
            </Center>
          ) : (
            <AgentChat
              messages={messages}
              busy={busy}
              error={error}
              onSend={(p) => run(p)}
              placeholder="Answer the agent, or ask it to update the context…"
              emptyHint="Start by onboarding this workspace."
              suggestions={context?.suggestedAnalyses?.map((a) => ({
                id: a.id,
                title: a.title,
              }))}
              onSuggestion={(id) => {
                const a = context?.suggestedAnalyses?.find((x) => x.id === id);
                if (a) onCreateNotebook({ title: a.title, prompt: a.prompt });
              }}
            />
          )}
        </Stack>
      </div>

      {/* Right: context built by the conversation */}
      <div className="aegis-pane aegis-pane--canvas">
        <div className="aegis-scroll">
          <Center axis="horizontal" padding={5} width="100%">
            <Stack gap={5} maxWidth={1200} width="100%">
            <Stack direction="horizontal" gap={3} vAlign="center" justify="between">
              <Stack gap={0}>
                <Text type="large" weight="semibold">
                  {workspaceName}
                </Text>
                <Text type="supporting" color="secondary">
                  Workspace context is shared by every notebook.
                </Text>
              </Stack>
              {onboarded ? (
                <Badge
                  label={`Context ready · ${status?.tables ?? 0} tables`}
                  variant="success"
                />
              ) : (
                <Badge label="Not onboarded" variant="warning" />
              )}
            </Stack>

            {stale && (
              <Text type="supporting" color="secondary">
                New data since the last onboarding — re-run it so the agent sees
                the new tables.
              </Text>
            )}

            <Card>
              <Stack gap={3}>
                <Stack direction="horizontal" gap={2} vAlign="center" justify="between">
                  <Text weight="semibold">
                    <Database size={15} /> Data sources
                  </Text>
                  <Text type="supporting" color="secondary">
                    {dataFiles.length} file{dataFiles.length === 1 ? "" : "s"}
                  </Text>
                </Stack>
                {dataFiles.length > 0 ? (
                  <Stack gap={1}>
                    {dataFiles.map((f) => (
                      <Stack key={f.name} direction="horizontal" gap={2} vAlign="center">
                        <FileText size={14} />
                        <Text type="supporting">{f.name}</Text>
                        <Text type="supporting" color="secondary">
                          {formatBytes(f.bytes)}
                        </Text>
                      </Stack>
                    ))}
                  </Stack>
                ) : (
                  <Text color="secondary">
                    No data yet. Upload CSV, Parquet, JSON or logs to begin.
                  </Text>
                )}
                <Button
                  label="Upload or drop files"
                  variant="secondary"
                  size="sm"
                  icon={<Upload size={15} />}
                  onClick={onOpenUpload}
                />
              </Stack>
            </Card>

            <Card>
              <Stack gap={3}>
                <Text weight="semibold">Context</Text>
                {!onboarded || !context ? (
                  <Text color="secondary">
                    Context will appear here as the agent learns about your data.
                  </Text>
                ) : (
                  <>
                    {context.metadataSchema?.tables &&
                      Object.keys(context.metadataSchema.tables).length > 0 && (
                        <Stack gap={2}>
                          <Text type="label" color="secondary">
                            Tables
                          </Text>
                          {Object.entries(context.metadataSchema.tables).map(
                            ([name, t]) => (
                              <Stack key={name} gap={0}>
                                <Text type="supporting" weight="medium">
                                  {name} · {t.rowCount ?? "?"} rows ·{" "}
                                  {t.columns?.length ?? 0} cols
                                </Text>
                                <Text type="supporting" color="secondary">
                                  {t.columns
                                    ?.map((c) => `${c.name} ${c.type}`)
                                    .join(", ")}
                                </Text>
                              </Stack>
                            ),
                          )}
                        </Stack>
                      )}
                    <Divider />
                    <Markdown>
                      {context.onboardingContext || "_No context generated yet._"}
                    </Markdown>
                  </>
                )}
              </Stack>
            </Card>

            <Card>
              <Stack gap={3}>
                <Text weight="semibold">Your notes</Text>
                <Text type="supporting" color="secondary">
                  Domain knowledge the agent should know (currency, definitions,
                  business rules).
                </Text>
                <NotesEditor initial={context?.userNotes ?? ""} onSave={onSaveNotes} />
              </Stack>
            </Card>

            <Card>
              <Stack gap={3}>
                <Stack direction="horizontal" gap={3} vAlign="center" justify="between">
                  <Stack gap={0}>
                    <Text weight="semibold">Recovery</Text>
                    <Text type="supporting" color="secondary">
                      Re-download uploaded files from the immutable backup store.
                    </Text>
                  </Stack>
                  <Button
                    label="Restore from backup"
                    variant="secondary"
                    size="sm"
                    icon={<RotateCcw size={15} />}
                    onClick={onRestore}
                  />
                </Stack>
                <Divider />
                <Stack direction="horizontal" gap={3} vAlign="center" justify="between">
                  <Stack gap={0}>
                    <Text weight="semibold">Delete workspace</Text>
                    <Text type="supporting" color="secondary">
                      Permanently remove this workspace, its context, data,
                      notebooks and backups.
                    </Text>
                  </Stack>
                  <Button
                    label="Delete"
                    variant="destructive"
                    size="sm"
                    icon={<Trash2 size={15} />}
                    onClick={() => setDeleteOpen(true)}
                  />
                </Stack>
              </Stack>
            </Card>

            {onboarded && !hasNotebooks && (
              <Card variant="muted">
                <Stack direction="horizontal" gap={3} vAlign="center" justify="between">
                  <Stack gap={0}>
                    <Text weight="medium">Ready to analyze</Text>
                    <Text type="supporting" color="secondary">
                      Create a notebook to ask questions and build dashboards.
                    </Text>
                  </Stack>
                  <Stack direction="horizontal" gap={2}>
                    <Button
                      label="Starter dashboard"
                      variant="primary"
                      icon={<Sparkles size={15} />}
                      onClick={() => onCreateNotebook({ starter: true })}
                    />
                    <Button
                      label="Blank notebook"
                      variant="secondary"
                      icon={<Plus size={15} />}
                      onClick={() => onCreateNotebook()}
                    />
                  </Stack>
                </Stack>
              </Card>
            )}
            </Stack>
          </Center>
        </div>
      </div>

      <AlertDialog
        isOpen={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete “${workspaceName}”?`}
        description="This permanently deletes the workspace, its onboarding context, uploaded data, notebooks, widgets and backups. This action cannot be undone."
        actionLabel="Delete workspace"
        actionVariant="destructive"
        isActionLoading={deleting}
        onAction={async () => {
          setDeleting(true);
          try {
            await onDelete();
          } finally {
            setDeleting(false);
            setDeleteOpen(false);
          }
        }}
      />
    </>
  );
}

function NotesEditor({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (notes: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await onSave(value);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap={2}>
      <TextArea
        label="User notes"
        isLabelHidden
        value={value}
        onChange={(v) => setValue(v)}
        rows={4}
        placeholder="e.g. amount is in INR paise; refunded orders should be excluded from revenue."
      />
      <Stack direction="horizontal" gap={2} vAlign="center">
        <Button
          label="Save notes"
          size="sm"
          variant="secondary"
          icon={<Save size={14} />}
          isLoading={saving}
          onClick={save}
        />
        {saved && (
          <Text type="supporting" color="secondary">
            Saved.
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
