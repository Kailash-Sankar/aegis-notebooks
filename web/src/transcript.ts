import type { ChatMessage } from "./types.js";

/**
 * Convert a persisted Pi session entry tree (chat_history.json) into chat
 * bubbles. Only user/assistant text is shown; tool calls and results are
 * omitted. Tolerant of malformed data.
 */
export function transcriptToMessages(entries: unknown): ChatMessage[] {
  if (!Array.isArray(entries)) return [];
  const out: ChatMessage[] = [];
  for (const raw of entries) {
    const entry = raw as { type?: string; message?: Record<string, unknown> };
    if (entry?.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(entry.message.content);
    if (!text.trim()) continue;
    out.push({ role, text });
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
      const text = (p as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}
