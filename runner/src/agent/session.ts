import { rename, writeFile } from "node:fs/promises";
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
import { KeyedQueue } from "../util/keyed-queue.js";

interface SessionHandle {
  session: AgentSession;
  manager: SessionManager;
}

/**
 * Outcome of one agent turn. `contextSaved` is an explicit signal (not a guess
 * or a file diff) that the agent called `save_context` during this turn, so the
 * UI can confirm the workspace memory really changed. `onboarding` is the
 * post-turn workspace status.
 */
export interface AgentRunResult {
  text: string;
  contextSaved: boolean;
  /** True when the agent persisted a full-page report during this turn. */
  reportSaved: boolean;
  onboarding: Awaited<ReturnType<WorkspaceManager["getOnboardingStatus"]>>;
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
  /** One turn at a time per workspace/notebook so transcripts aren't clobbered. */
  private readonly runs = new KeyedQueue();
  /** Counts `save_context` commits per scope, used to detect a save this turn. */
  private readonly contextSaves = new Map<string, number>();
  /** Counts `write_report` commits per scope, used to detect a report this turn. */
  private readonly reportSaves = new Map<string, number>();
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
  ): Promise<AgentRunResult> {
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
  ): Promise<AgentRunResult> {
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
  ): Promise<AgentRunResult> {
    return this.runScoped(workspaceId, notebookId, prompt, onEvent);
  }

  private scopeKey(workspaceId: string, notebookId: string | null): string {
    return notebookId ? `${workspaceId}/${notebookId}` : `${workspaceId}/__onboard__`;
  }

  private runScoped(
    workspaceId: string,
    notebookId: string | null,
    prompt: string,
    onEvent?: (event: unknown) => void,
  ): Promise<AgentRunResult> {
    return this.runs.run(this.scopeKey(workspaceId, notebookId), () =>
      this.runScopedUnlocked(workspaceId, notebookId, prompt, onEvent),
    );
  }

  private async runScopedUnlocked(
    workspaceId: string,
    notebookId: string | null,
    prompt: string,
    onEvent?: (event: unknown) => void,
  ): Promise<AgentRunResult> {
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

    const key = this.scopeKey(workspaceId, notebookId);
    const contextSavesBefore = this.contextSaves.get(key) ?? 0;
    const reportSavesBefore = this.reportSaves.get(key) ?? 0;
    const unsubscribe = onEvent ? handle.session.subscribe(onEvent) : () => {};
    try {
      await handle.session.prompt(prompt);
      return {
        text: handle.session.getLastAssistantText() ?? "",
        contextSaved: (this.contextSaves.get(key) ?? 0) > contextSavesBefore,
        reportSaved: (this.reportSaves.get(key) ?? 0) > reportSavesBefore,
        onboarding: await this.workspaces.getOnboardingStatus(workspaceId),
      };
    } finally {
      unsubscribe();
      // Persist on success *and* failure. The user turn (and any completed
      // tool calls) are already in the session tree. If we skipped this after
      // an error, the ephemeral onboarding session would reload an older
      // transcript next turn and the agent would re-ask questions / never
      // commit context -- the "stuck" behaviour. Never let a write failure
      // mask the original error.
      await this.persistTranscript(transcriptPath, handle.manager).catch((err) => {
        console.error(`[agent] failed to persist transcript ${transcriptPath}:`, err);
      });
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
      reportsDir: nb?.reportsDir ?? `${paths.memoryDir}/reports`,
      config: this.config,
      registry: this.registry,
      onContextSaved: async () => {
        this.contextSaves.set(
          this.scopeKey(workspaceId, notebookId),
          (this.contextSaves.get(this.scopeKey(workspaceId, notebookId)) ?? 0) + 1,
        );
        // Committing context in workspace scope marks onboarding complete.
        if (!notebookId) await this.workspaces.markOnboarded(workspaceId);
        // Any other session's injected context is now stale. Skip the session
        // currently executing: disposing it mid-turn would abort the agent.
        this.disposeNotebookSessions(workspaceId, notebookId ?? undefined);
      },
      onReportSaved: async () => {
        const key = this.scopeKey(workspaceId, notebookId);
        this.reportSaves.set(key, (this.reportSaves.get(key) ?? 0) + 1);
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
          "write_report",
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

  /**
   * Drop cached notebook sessions so they pick up refreshed context. Pass
   * `exceptNotebookId` to keep a session that is currently executing.
   */
  disposeNotebookSessions(workspaceId: string, exceptNotebookId?: string): void {
    const prefix = `${workspaceId}/`;
    const keep = exceptNotebookId ? `${workspaceId}/${exceptNotebookId}` : null;
    for (const [key, handle] of this.sessions) {
      if (key.startsWith(prefix) && key !== keep) {
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
    // a fresh SessionManager and rebuild the same model context. Write to a
    // temp file + rename so a crash mid-write can't corrupt the transcript.
    const payload = JSON.stringify(manager.getEntries(), null, 2);
    const tmp = `${chatHistoryPath}.tmp`;
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, chatHistoryPath);
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
