import { useState } from "react";
import { Send, Sparkles } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import type { ChatMessage } from "../types.js";

/** Append a streamed assistant delta to the last assistant message. */
export function appendAssistantDelta(
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void,
  delta: string,
): void {
  setMessages((prev) => {
    const next = [...prev];
    const last = next[next.length - 1];
    if (last && last.role === "assistant") {
      next[next.length - 1] = { ...last, text: last.text + delta };
    }
    return next;
  });
}

export interface Suggestion {
  id: string;
  title: string;
}

/**
 * Chat transcript + composer, shared by notebook analysis and the workspace
 * onboarding conversation. Optional suggestion chips sit above the composer and
 * hide as soon as the user starts typing.
 */
export function AgentChat({
  messages,
  busy,
  error,
  notice,
  onSend,
  placeholder,
  emptyHint,
  suggestions,
  onSuggestion,
}: {
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  notice?: string | null;
  onSend: (prompt: string) => void;
  placeholder: string;
  emptyHint: string;
  suggestions?: Suggestion[];
  onSuggestion?: (id: string) => void;
}) {
  const [input, setInput] = useState("");
  const [dismissed, setDismissed] = useState(false);

  function send() {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setInput("");
    onSend(prompt);
  }

  const showSuggestions =
    !dismissed &&
    !busy &&
    input.trim() === "" &&
    (suggestions?.length ?? 0) > 0;

  return (
    <>
      <div className="aegis-scroll">
        <Stack gap={4} padding={4}>
          {messages.length === 0 && <Text color="secondary">{emptyHint}</Text>}
          {messages.map((m, i) => (
            <div className="aegis-chat-row" key={i}>
              <span
                className={
                  m.role === "assistant"
                    ? "aegis-avatar aegis-avatar--ai"
                    : "aegis-avatar"
                }
              >
                {m.role === "assistant" ? "AI" : "You"}
              </span>
              <Stack gap={0} width="100%">
                {m.role === "assistant" ? (
                  <Markdown isStreaming={busy && i === messages.length - 1}>
                    {m.text || "…"}
                  </Markdown>
                ) : (
                  <Text>{m.text}</Text>
                )}
              </Stack>
            </div>
          ))}
          {busy && (
            <Stack direction="horizontal" gap={2} vAlign="center">
              <Spinner size="sm" />
              <Text type="supporting" color="secondary">
                agent is working…
              </Text>
            </Stack>
          )}
          {notice && <div className="aegis-notice">✓ {notice}</div>}
          {error && <div className="aegis-error">{error}</div>}
        </Stack>
      </div>

      {showSuggestions && (
        <div className="aegis-suggestions">
          <div className="aegis-suggestions-head">
            <Text type="label" color="secondary">
              Suggested analyses
            </Text>
            <button
              className="aegis-suggestions-dismiss"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss suggestions"
            >
              ✕
            </button>
          </div>
          <Stack direction="horizontal" gap={2} wrap="wrap">
            {suggestions!.map((s) => (
              <Button
                key={s.id}
                label={s.title}
                variant="secondary"
                size="sm"
                icon={<Sparkles size={14} />}
                onClick={() => onSuggestion?.(s.id)}
              />
            ))}
          </Stack>
        </div>
      )}

      <form
        className="aegis-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      >
        <Stack width="100%">
          <TextArea
            label="Message"
            isLabelHidden
            value={input}
            onChange={(value) => setInput(value)}
            placeholder={placeholder}
            rows={2}
          />
        </Stack>
        <Button
          label="Send"
          type="submit"
          size="sm"
          icon={<Send size={15} />}
          isDisabled={busy}
        />
      </form>
    </>
  );
}
