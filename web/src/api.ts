import type {
  AgentRunResult,
  DataFile,
  Notebook,
  QueryResult,
  Report,
  ReportMeta,
  Widget,
  Workspace,
  WorkspaceContext,
} from "./types.js";

const BASE = "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export function listWorkspaces(): Promise<Workspace[]> {
  return fetch(`${BASE}/workspaces`).then(json<Workspace[]>);
}

export function deleteWorkspace(workspaceId: string): Promise<unknown> {
  return fetch(`${BASE}/workspaces/${workspaceId}`, { method: "DELETE" }).then(
    json<unknown>,
  );
}

export function createWorkspace(name: string): Promise<Workspace> {
  return fetch(`${BASE}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(json<Workspace>);
}

export function listNotebooks(workspaceId: string): Promise<Notebook[]> {
  return fetch(`${BASE}/workspaces/${workspaceId}/notebooks`).then(json<Notebook[]>);
}

export function createNotebook(workspaceId: string, title: string): Promise<Notebook> {
  return fetch(`${BASE}/workspaces/${workspaceId}/notebooks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  }).then(json<Notebook>);
}

export function listData(workspaceId: string): Promise<DataFile[]> {
  return fetch(`${BASE}/workspaces/${workspaceId}/data`).then(json<DataFile[]>);
}

export function uploadFile(workspaceId: string, file: File): Promise<unknown> {
  return fetch(`${BASE}/workspaces/${workspaceId}/uploads`, {
    method: "POST",
    headers: { "x-filename": file.name, "content-type": "application/octet-stream" },
    body: file,
  }).then(json<unknown>);
}

export function getTranscript(workspaceId: string, notebookId: string): Promise<unknown> {
  return fetch(
    `${BASE}/workspaces/${workspaceId}/notebooks/${notebookId}/transcript`,
  ).then(json<unknown>);
}

export function listWidgets(workspaceId: string, notebookId: string): Promise<Widget[]> {
  return fetch(`${BASE}/workspaces/${workspaceId}/notebooks/${notebookId}/widgets`).then(
    json<Widget[]>,
  );
}

export function listReports(
  workspaceId: string,
  notebookId: string,
): Promise<ReportMeta[]> {
  return fetch(`${BASE}/workspaces/${workspaceId}/notebooks/${notebookId}/reports`).then(
    json<ReportMeta[]>,
  );
}

export function getReport(
  workspaceId: string,
  notebookId: string,
  reportId: string,
): Promise<Report> {
  return fetch(
    `${BASE}/workspaces/${workspaceId}/notebooks/${notebookId}/reports/${reportId}`,
  ).then(json<Report>);
}

export function deleteReport(
  workspaceId: string,
  notebookId: string,
  reportId: string,
): Promise<unknown> {
  return fetch(
    `${BASE}/workspaces/${workspaceId}/notebooks/${notebookId}/reports/${reportId}`,
    { method: "DELETE" },
  ).then(json<unknown>);
}

export interface LayoutItemInput {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Persist user-arranged canvas layout (drag/resize). */
export function saveLayout(
  workspaceId: string,
  notebookId: string,
  layout: LayoutItemInput[],
): Promise<unknown> {
  return fetch(`${BASE}/workspaces/${workspaceId}/notebooks/${notebookId}/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout }),
  }).then(json<unknown>);
}

export interface RestoreResult {
  workspaceId: string;
  uploadsRestored: number;
  uploadsFailed: string[];
  uploadsWithoutBackup: string[];
}

export function restoreWorkspace(workspaceId: string): Promise<RestoreResult> {
  return fetch(`${BASE}/workspaces/${workspaceId}/restore`, { method: "POST" }).then(
    json<RestoreResult>,
  );
}

export function runQuery(workspaceId: string, sql: string): Promise<QueryResult> {
  return fetch(`${BASE}/workspaces/${workspaceId}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  }).then(json<QueryResult>);
}

/**
 * Stream a chat run over SSE. Calls onDelta for each assistant text delta and
 * resolves with the final assistant text.
 */
export function streamChat(
  workspaceId: string,
  notebookId: string,
  prompt: string,
  onDelta: (text: string) => void,
): Promise<AgentRunResult> {
  return streamRun(
    `${BASE}/workspaces/${workspaceId}/notebooks/${notebookId}/chat`,
    { prompt },
    onDelta,
  );
}

/** Workspace-scoped context: onboarding status, memory, user notes. */
export function getContext(workspaceId: string): Promise<WorkspaceContext> {
  return fetch(`${BASE}/workspaces/${workspaceId}/context`).then(
    json<WorkspaceContext>,
  );
}

export function saveNotes(workspaceId: string, notes: string): Promise<unknown> {
  return fetch(`${BASE}/workspaces/${workspaceId}/notes`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes }),
  }).then(json<unknown>);
}

/** Start workspace-scoped onboarding (streamed). */
export function streamOnboard(
  workspaceId: string,
  onDelta: (text: string) => void,
): Promise<AgentRunResult> {
  return streamRun(`${BASE}/workspaces/${workspaceId}/onboard`, {}, onDelta);
}

/** Continue the onboarding conversation (streamed). */
export function streamOnboardChat(
  workspaceId: string,
  prompt: string,
  onDelta: (text: string) => void,
): Promise<AgentRunResult> {
  return streamRun(`${BASE}/workspaces/${workspaceId}/onboard/chat`, { prompt }, onDelta);
}

export function getOnboardTranscript(workspaceId: string): Promise<unknown> {
  return fetch(`${BASE}/workspaces/${workspaceId}/onboard/transcript`).then(
    json<unknown>,
  );
}

export function resetOnboarding(workspaceId: string): Promise<unknown> {
  return fetch(`${BASE}/workspaces/${workspaceId}/onboard/reset`, {
    method: "POST",
  }).then(json<unknown>);
}

async function streamRun(
  url: string,
  body: unknown,
  onDelta: (text: string) => void,
): Promise<AgentRunResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`run failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AgentRunResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const { event, data } = parseFrame(frame);
      if (event === "pi" && isTextDelta(data)) {
        onDelta(data.assistantMessageEvent.delta);
      }
      if (event === "done") result = data as AgentRunResult;
      if (event === "error") throw new Error((data as { error?: string }).error ?? "agent error");
    }
  }
  if (!result) throw new Error("stream ended without a result");
  return result;
}

function parseFrame(frame: string): { event: string; data: unknown } {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    if (line.startsWith("data: ")) data += line.slice(6);
  }
  try {
    return { event, data: JSON.parse(data || "null") };
  } catch {
    return { event, data: null };
  }
}

function isTextDelta(
  data: unknown,
): data is { assistantMessageEvent: { delta: string } } {
  const d = data as {
    type?: string;
    assistantMessageEvent?: { type?: string; delta?: string };
  };
  return (
    d?.type === "message_update" &&
    d.assistantMessageEvent?.type === "text_delta" &&
    typeof d.assistantMessageEvent.delta === "string"
  );
}
