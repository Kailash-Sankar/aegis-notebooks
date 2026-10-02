import { useEffect, useRef, useState } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { getTranscript, streamChat } from "../api.js";
import { transcriptToMessages } from "../transcript.js";
import type { ChatMessage } from "../types.js";
import { AgentChat, appendAssistantDelta } from "./AgentChat.js";

/**
 * Notebook analysis chat. Owns its messages and loads the persisted transcript,
 * so a first run (e.g. a suggested analysis) is never clobbered by the
 * transcript load.
 */
export function ChatPanel({
  workspaceId,
  notebookId,
  onRunComplete,
  onReportSaved,
  initialPrompt,
  initialLabel,
  onInitialPromptConsumed,
}: {
  workspaceId: string;
  notebookId: string;
  onRunComplete: () => void;
  /** Called when the agent wrote a full-page report this turn. */
  onReportSaved?: () => void;
  initialPrompt?: string;
  initialLabel?: string;
  onInitialPromptConsumed?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    let cancelled = false;
    started.current = false;
    setLoaded(false);
    setMessages([]);
    getTranscript(workspaceId, notebookId)
      .then((entries) => {
        if (!cancelled) {
          setMessages(transcriptToMessages(entries));
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMessages([]);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, notebookId]);

  // Kick off a first run (e.g. a curated analysis) once the transcript is loaded
  // and only if the notebook is empty.
  useEffect(() => {
    if (!loaded || started.current || !initialPrompt || messages.length > 0) return;
    started.current = true;
    void send(initialPrompt, initialLabel);
    onInitialPromptConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, initialPrompt, messages.length]);

  async function reloadTranscript(): Promise<void> {
    try {
      const entries = await getTranscript(workspaceId, notebookId);
      setMessages(transcriptToMessages(entries));
    } catch {
      // Keep the current view if the transcript can't be read.
    }
  }

  async function send(prompt: string, label?: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: label ?? prompt },
      { role: "assistant", text: "" },
    ]);
    try {
      const result = await streamChat(workspaceId, notebookId, prompt, (delta) =>
        appendAssistantDelta(setMessages, delta),
      );
      if (result.contextSaved) setNotice("Workspace context saved.");
      if (result.reportSaved) {
        setNotice("Report saved.");
        onReportSaved?.();
      }
      onRunComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // The runner persists the turn even when it errors; reconcile the
      // bubbles with disk so the UI matches what the model actually saw.
      await reloadTranscript();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack direction="vertical" height="100%">
      <div className="aegis-pane-header">
        <Text type="label" color="secondary">
          Agent
        </Text>
      </div>
      <AgentChat
        messages={messages}
        busy={busy}
        error={error}
        notice={notice}
        onSend={send}
        placeholder="e.g. Chart total amount by region"
        emptyHint="Ask the agent to inspect your data or build a dashboard."
      />
    </Stack>
  );
}
