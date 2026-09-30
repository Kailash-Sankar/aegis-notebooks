import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import type { RegistryProjection } from "../registry/pocketbase.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { createAnalyticsTools, type ToolContext } from "./tools.js";
import {
  buildWorkspaceInstructions,
  ONBOARDING_PROMPT,
  WORKSPACE_INSTRUCTIONS_PATH,
} from "./instructions.js";
import { resolveModel, type ResolvedModel } from "./model.js";

interface SessionHandle {
  session: AgentSession;
  manager: SessionManager;
}

/**
 * Agent sessions. There are two scopes:
 *
 * - **Workspace scope** (onboarding): no notebook. Loads data into DuckDB and
 *   writes workspace memory. Transcript lives at `memory/onboarding_transcript.json`
 *   and the session is ephemeral (fresh each run, so it always sees the latest
 *   context).
 * - **Notebook scope** (analysis): chat + canvas. One cached session per
 *   notebook, transcript at `notebooks/<id>/chat_history.json`.
 *
 * Context (onboarding memory) is injected as an AGENTS.md file, so it is shared
 * by every notebook in the workspace (ADR 0002).
 */
export class AgentRunner {
  private readonly sessions = new Map<string, SessionHandle>();
  private modelPromise: Promise<ResolvedModel | null> | undefined;

  constructor(
    private readonly config: Config,
    private readonly registry: RegistryProjection,
    private readonly workspaces: WorkspaceManager,
  ) {}

  /** Start the workspace-scoped data-discovery onboarding task. */
  onboardWorkspace(
    workspaceId: string,
    onEvent?: (event: unknown) => void,
  ): Promise<string> {
    return this.runScoped(workspaceId, null, ONBOARDING_PROMPT, onEvent);
  }

  /**
   * Continue the onboarding conversation with a user message (e.g. answering a
   * clarifying question). The session is rebuilt from the persisted transcript
   * each turn, so context always reflects the latest workspace memory.
   */
  onboardChat(
    workspaceId: string,
    prompt: string,
    onEvent?: (event: unknown) => void,
  ): Promise<string> {
    return this.runScoped(workspaceId, null, prompt, onEvent);
  }

  /** Read the persisted onboarding transcript entries (for the UI). */
  onboardTranscriptPath(workspaceId: string): string {
    return this.workspaces.pathsFor(workspaceId).onboardingTranscript;
  }

  /** Run a chat prompt in a notebook (analysis scope). */
  run(
    workspaceId: string,
    notebookId: string,
    prompt: string,
    onEvent?: (event: unknown) => void,
  ): Promise<string> {
    return this.runScoped(workspaceId, notebookId, prompt, onEvent);
  }

  private async runScoped(
    workspaceId: string,
    notebookId: string | null,
    prompt: string,
    onEvent?: (event: unknown) => void,
  ): Promise<string> {
    await this.workspaces.require(workspaceId);
    const paths = this.workspaces.pathsFor(workspaceId);

    let handle: SessionHandle;
    let transcriptPath: string;
    let ephemeral = false;

    if (notebookId) {
      const notebook = await this.workspaces.getNotebook(workspaceId, notebookId);
      if (!notebook) throw new Error(`Notebook not found: ${notebookId}`);
      handle = await this.getOrCreateSession(workspaceId, notebookId, paths);
      transcriptPath = paths.notebook(notebookId).chatHistory;
    } else {
      handle = await this.createSession(workspaceId, null, paths, paths.onboardingTranscript);
      transcriptPath = paths.onboardingTranscript;
      ephemeral = true;
    }

    const unsubscribe = onEvent ? handle.session.subscribe(onEvent) : () => {};
    try {
      await handle.session.prompt(prompt);
      const text = handle.session.getLastAssistantText() ?? "";
      await this.persistTranscript(transcriptPath, handle.manager);
      return text;
    } finally {
      unsubscribe();
      if (ephemeral) handle.session.dispose();
    }
  }

  private async getOrCreateSession(
    workspaceId: string,
    notebookId: string,
    paths: ReturnType<WorkspaceManager["pathsFor"]>,
  ): Promise<SessionHandle> {
    const key = `${workspaceId}/${notebookId}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const handle = await this.createSession(
      workspaceId,
      notebookId,
      paths,
      paths.notebook(notebookId).chatHistory,
    );
    this.sessions.set(key, handle);
    return handle;
  }

  private async createSession(
    workspaceId: string,
    notebookId: string | null,
    paths: ReturnType<WorkspaceManager["pathsFor"]>,
    transcriptPath: string,
  ): Promise<SessionHandle> {
    const nb = notebookId ? paths.notebook(notebookId) : null;
    const toolContext: ToolContext = {
      workspaceId,
      notebookId: notebookId ?? "",
      workspaceRoot: paths.root,
      duckdbPath: paths.duckdb,
      assetsDir: nb?.assetsDir ?? paths.memoryDir,
      config: this.config,
      registry: this.registry,
      // Workspace scope only: committing context marks onboarding complete.
      onContextSaved: notebookId
        ? undefined
        : async () => {
            await this.workspaces.markOnboarded(workspaceId);
            this.disposeNotebookSessions(workspaceId);
          },
    };

    // Inject workspace context (onboarding memory) as an AGENTS.md file.
    const loader = new DefaultResourceLoader({
      cwd: paths.root,
      agentDir: getAgentDir(),
      agentsFilesOverride: (current) => {
        const files = [...current.agentsFiles];
        files.push({
          path: WORKSPACE_INSTRUCTIONS_PATH,
          content: buildWorkspaceInstructions(),
        });
        if (existsSync(paths.onboardingContext)) {
          files.push({
            path: paths.onboardingContext,
            content: readFileSync(paths.onboardingContext, "utf8"),
          });
        }
        if (existsSync(paths.userNotes)) {
          files.push({
            path: paths.userNotes,
            content: readFileSync(paths.userNotes, "utf8"),
          });
        }
        return { agentsFiles: files };
      },
    });
    await loader.reload();

    const manager = SessionManager.inMemory(paths.root, undefined, loadEntries(transcriptPath));
    const resolved = await this.resolveModel();

    // NOTE: `tools` is an allowlist -- custom tools must be listed here too,
    // or they are registered but inactive ("Tool ... not found").
    // NOTE: `tools` is an allowlist -- custom tools must be listed here too.
    // Workspace (onboarding) scope deliberately omits write/edit so the durable
    // context can only be committed through `save_context`. Notebook scope adds
    // write/edit and write_widget for analysis.
    const tools = notebookId
      ? [
          "read",
          "write",
          "edit",
          "bash",
          "grep",
          "find",
          "ls",
          "duckdb_query",
          "register_dataset",
          "suggest_analysis",
          "save_context",
          "write_widget",
        ]
      : [
          "read",
          "bash",
          "grep",
          "find",
          "ls",
          "duckdb_query",
          "register_dataset",
          "suggest_analysis",
          "save_context",
        ];

    const { session } = await createAgentSession({
      cwd: paths.root,
      resourceLoader: loader,
      sessionManager: manager,
      tools,
      customTools: createAnalyticsTools(toolContext),
      thinkingLevel: this.config.AEGIS_THINKING,
      ...(resolved ? { model: resolved.model, modelRuntime: resolved.runtime } : {}),
    });

    return { session, manager };
  }

  /** Drop cached notebook sessions so they pick up refreshed context. */
  disposeNotebookSessions(workspaceId: string): void {
    const prefix = `${workspaceId}/`;
    for (const [key, handle] of this.sessions) {
      if (key.startsWith(prefix)) {
        handle.session.dispose();
        this.sessions.delete(key);
      }
    }
  }

  /** Resolve the configured model once per runner. */
  private resolveModel(): Promise<ResolvedModel | null> {
    this.modelPromise ??= resolveModel(this.config)
      .then((resolved) => {
        if (resolved) {
          console.log(
            `[agent] model: ${resolved.model.provider}/${resolved.model.id} ` +
              `(thinking=${this.config.AEGIS_THINKING})`,
          );
        } else {
          console.warn("[agent] no model resolved; using Pi defaults");
        }
        return resolved;
      })
      .catch((err) => {
        console.error("[agent] model resolution failed:", err);
        return null;
      });
    return this.modelPromise;
  }

  private async persistTranscript(
    chatHistoryPath: string,
    manager: SessionManager,
  ): Promise<void> {
    // Persist the entry tree (not session.messages) so it can be reloaded into
    // a fresh SessionManager and rebuild the same model context.
    await writeFile(chatHistoryPath, JSON.stringify(manager.getEntries(), null, 2), "utf8");
  }

  dispose(): void {
    for (const { session } of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

/**
 * Load persisted session entries. Tolerates an empty, missing, or
 * older-format file by starting a fresh session.
 */
export function loadEntries(chatHistoryPath: string): FileEntry[] {
  if (!existsSync(chatHistoryPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(chatHistoryPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is FileEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as { type?: unknown }).type === "string",
    );
  } catch {
    return [];
  }
}
