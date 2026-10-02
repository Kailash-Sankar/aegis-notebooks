import "./env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createRegistry } from "./registry/pocketbase.js";
import { reconcile } from "./registry/reconcile.js";
import { createBackupStore } from "./backup/rustfs.js";
import { BackupService } from "./backup/manifest.js";
import { restoreWorkspace } from "./backup/restore.js";
import { QuotaService, QuotaError } from "./ingest/quota.js";
import { ingestUpload, type IngestDeps } from "./ingest/upload.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { runQuery } from "./workspace/query.js";
import { deleteReport, listReports, readReport } from "./workspace/reports.js";
import { AgentRunner, type AgentRunResult } from "./agent/session.js";

const config = loadConfig();
const registry = createRegistry(config);
const backup = new BackupService(createBackupStore(config), registry);
const quota = new QuotaService(config);
const workspaces = new WorkspaceManager(config, registry);
const agent = new AgentRunner(config, registry, workspaces);
const deps: IngestDeps = { workspaces, registry, backup, quota };

async function main(): Promise<void> {
  if (backup.enabled) {
    await backup.ensureReady().catch((err) => {
      console.warn("[backup] could not ensure bucket (backups will fail):", err);
    });
  }

  const result = await reconcile(workspaces, registry).catch((err) => {
    console.warn("[reconcile] failed (continuing with disk authority):", err);
    return { workspaces: 0, notebooks: 0 };
  });
  console.log(
    `[runner] registry=${config.registryEnabled ? "on" : "off"} ` +
      `backups=${config.backupsEnabled ? "on" : "off"} ` +
      `reconciled=${result.workspaces} ws / ${result.notebooks} nb`,
  );

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof QuotaError ? 413 : 400;
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  server.listen(config.PORT, () => {
    console.log(`[runner] listening on http://127.0.0.1:${config.PORT}`);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  // GET /health[?deep=1]  -- deep pings PocketBase reachability
  if (method === "GET" && parts[0] === "health") {
    const base = {
      ok: true,
      registry: config.registryEnabled,
      backups: config.backupsEnabled,
    };
    if (url.searchParams.get("deep") !== "1" || !config.registryEnabled) {
      return send(res, 200, base);
    }
    let pocketbaseReachable = false;
    try {
      const r = await fetch(`${config.POCKETBASE_URL}/api/health`);
      pocketbaseReachable = r.ok;
    } catch {
      pocketbaseReachable = false;
    }
    return send(res, pocketbaseReachable ? 200 : 503, {
      ...base,
      ok: pocketbaseReachable,
      pocketbaseReachable,
    });
  }

  // GET|POST /workspaces
  if (parts[0] === "workspaces" && parts.length === 1) {
    if (method === "GET") return send(res, 200, await workspaces.list());
    if (method === "POST") {
      const body = await readJson<{ name?: string }>(req);
      if (!body.name) return send(res, 400, { error: "name is required" });
      return send(res, 201, await workspaces.create(body.name));
    }
  }

  if (parts[0] === "workspaces" && parts[1]) {
    const workspaceId = parts[1];

    // GET /workspaces/:id
    if (method === "GET" && parts.length === 2) {
      const ws = await workspaces.get(workspaceId);
      return ws ? send(res, 200, ws) : send(res, 404, { error: "not found" });
    }

    // DELETE /workspaces/:id  -- full clean: disk + registry + backups
    if (method === "DELETE" && parts.length === 2) {
      await workspaces.require(workspaceId);
      agent.disposeNotebookSessions(workspaceId);
      await backup.deleteWorkspaceBackups(workspaceId).catch((err) => {
        console.warn("[workspace] backup cleanup failed:", err);
      });
      await registry.deleteWorkspace(workspaceId).catch((err) => {
        console.warn("[workspace] registry cleanup failed:", err);
      });
      await workspaces.deleteWorkspace(workspaceId);
      return send(res, 200, { ok: true });
    }

    // POST /workspaces/:id/uploads  (raw body + x-filename header)
    if (method === "POST" && parts[2] === "uploads") {
      const filename = req.headers["x-filename"];
      if (typeof filename !== "string") {
        return send(res, 400, { error: "x-filename header is required" });
      }
      const data = await readBuffer(req);
      return send(res, 201, await ingestUpload(deps, workspaceId, filename, data));
    }

    // GET /workspaces/:id/data  -- raw files in the local working set
    if (method === "GET" && parts[2] === "data" && parts.length === 3) {
      await workspaces.require(workspaceId);
      return send(res, 200, await workspaces.listData(workspaceId));
    }

    // POST /workspaces/:id/query  (read-only SQL for live widgets)
    if (method === "POST" && parts[2] === "query" && parts.length === 3) {
      const body = await readJson<{ sql?: string }>(req);
      if (!body.sql) return send(res, 400, { error: "sql is required" });
      await workspaces.require(workspaceId);
      const paths = workspaces.pathsFor(workspaceId);
      return send(res, 200, await runQuery(config, paths.duckdb, body.sql));
    }

    // POST /workspaces/:id/restore
    if (method === "POST" && parts[2] === "restore" && parts.length === 3) {
      return send(res, 200, await restoreWorkspace(workspaces, registry, backup, workspaceId));
    }

    // POST /workspaces/:id/onboard  (SSE; workspace-scoped, no notebook)
    if (method === "POST" && parts[2] === "onboard" && parts.length === 3) {
      await workspaces.require(workspaceId);
      // Onboarding completion is recorded by the agent's save_context tool,
      // after the user confirms. The route only runs the turn.
      return streamRun(res, (onEvent) => agent.onboardWorkspace(workspaceId, onEvent));
    }

    // POST /workspaces/:id/onboard/chat  (SSE; continue the onboarding chat)
    if (
      method === "POST" &&
      parts[2] === "onboard" &&
      parts[3] === "chat" &&
      parts.length === 4
    ) {
      const body = await readJson<{ prompt?: string }>(req);
      if (!body.prompt) return send(res, 400, { error: "prompt is required" });
      return streamRun(res, (onEvent) =>
        agent.onboardChat(workspaceId, body.prompt!, onEvent),
      );
    }

    // GET /workspaces/:id/onboard/transcript
    if (
      method === "GET" &&
      parts[2] === "onboard" &&
      parts[3] === "transcript" &&
      parts.length === 4
    ) {
      await workspaces.require(workspaceId);
      const p = agent.onboardTranscriptPath(workspaceId);
      if (!existsSync(p)) return send(res, 200, []);
      try {
        return send(res, 200, JSON.parse(await readFile(p, "utf8")));
      } catch {
        return send(res, 200, []);
      }
    }

    // POST /workspaces/:id/onboard/reset
    if (
      method === "POST" &&
      parts[2] === "onboard" &&
      parts[3] === "reset" &&
      parts.length === 4
    ) {
      await workspaces.require(workspaceId);
      await workspaces.resetOnboarding(workspaceId);
      agent.disposeNotebookSessions(workspaceId);
      return send(res, 200, { ok: true });
    }

    // GET /workspaces/:id/context  -- workspace-global context + status
    if (method === "GET" && parts[2] === "context" && parts.length === 3) {
      await workspaces.require(workspaceId);
      const paths = workspaces.pathsFor(workspaceId);
      const status = await workspaces.getOnboardingStatus(workspaceId);
      const onboardingContext = existsSync(paths.onboardingContext)
        ? await readFile(paths.onboardingContext, "utf8")
        : "";
      let metadataSchema: unknown = null;
      if (existsSync(paths.metadataSchema)) {
        try {
          metadataSchema = JSON.parse(await readFile(paths.metadataSchema, "utf8"));
        } catch {
          metadataSchema = null;
        }
      }
      let suggestedAnalyses: unknown[] = [];
      const suggestionsPath = `${paths.memoryDir}/suggested_analyses.json`;
      if (existsSync(suggestionsPath)) {
        try {
          const parsed = JSON.parse(await readFile(suggestionsPath, "utf8"));
          if (Array.isArray(parsed)) suggestedAnalyses = parsed;
        } catch {
          suggestedAnalyses = [];
        }
      }
      return send(res, 200, {
        status,
        onboardingContext,
        userNotes: await workspaces.readUserNotes(workspaceId),
        metadataSchema,
        suggestedAnalyses,
      });
    }

    // PUT /workspaces/:id/notes  -- editable user context
    if (method === "PUT" && parts[2] === "notes" && parts.length === 3) {
      const body = await readJson<{ notes?: string }>(req);
      await workspaces.writeUserNotes(workspaceId, body.notes ?? "");
      return send(res, 200, { ok: true });
    }

    // GET|POST /workspaces/:id/notebooks
    if (parts[2] === "notebooks" && parts.length === 3) {
      if (method === "GET") return send(res, 200, await workspaces.listNotebooks(workspaceId));
      if (method === "POST") {
        const body = await readJson<{ title?: string }>(req);
        return send(
          res,
          201,
          await workspaces.createNotebook(workspaceId, body.title ?? "Untitled"),
        );
      }
    }

    // POST /workspaces/:id/notebooks/:nbId/chat  (SSE)
    if (method === "POST" && parts[2] === "notebooks" && parts[4] === "chat" && parts[3]) {
      const body = await readJson<{ prompt?: string }>(req);
      if (!body.prompt) return send(res, 400, { error: "prompt is required" });
      return streamChat(res, workspaceId, parts[3], body.prompt);
    }

    // GET /workspaces/:id/notebooks/:nbId/widgets
    if (method === "GET" && parts[2] === "notebooks" && parts[4] === "widgets" && parts[3]) {
      return send(res, 200, await registry.listWidgets(parts[3]));
    }

    // PUT /workspaces/:id/notebooks/:nbId/layout  (persist drag/resize)
    if (
      method === "PUT" &&
      parts[2] === "notebooks" &&
      parts[4] === "layout" &&
      parts[3]
    ) {
      const body = await readJson<{ layout?: unknown }>(req);
      const items = Array.isArray(body.layout) ? body.layout : [];
      // Only allow ids that actually belong to this notebook.
      const owned = new Set((await registry.listWidgets(parts[3])).map((w) => w.id));
      let updated = 0;
      for (const item of items) {
        const { id, x, y, w, h } = (item ?? {}) as Record<string, unknown>;
        if (typeof id !== "string" || !owned.has(id)) continue;
        await registry.updateWidgetPosition(id, { x, y, w, h });
        updated += 1;
      }
      return send(res, 200, { ok: true, updated });
    }

    // GET|POST /workspaces/:id/notebooks/:nbId/reports  (agent writes via tool)
    if (method === "GET" && parts[2] === "notebooks" && parts[4] === "reports" && parts.length === 5 && parts[3]) {
      const nb = workspaces.pathsFor(workspaceId).notebook(parts[3]);
      return send(res, 200, await listReports(nb.reportsDir));
    }

    // GET|DELETE /workspaces/:id/notebooks/:nbId/reports/:reportId
    if (
      parts[2] === "notebooks" &&
      parts[4] === "reports" &&
      parts[5] &&
      parts.length === 6 &&
      parts[3]
    ) {
      const nb = workspaces.pathsFor(workspaceId).notebook(parts[3]);
      if (method === "GET") {
        const report = await readReport(nb.reportsDir, parts[5]);
        return report ? send(res, 200, report) : send(res, 404, { error: "not found" });
      }
      if (method === "DELETE") {
        const removed = await deleteReport(nb.reportsDir, parts[5]);
        return send(res, removed ? 200 : 404, { ok: removed });
      }
    }

    // GET /workspaces/:id/notebooks/:nbId/transcript
    if (method === "GET" && parts[2] === "notebooks" && parts[4] === "transcript" && parts[3]) {
      const nb = workspaces.pathsFor(workspaceId).notebook(parts[3]);
      const { readFile } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      if (!existsSync(nb.chatHistory)) return send(res, 404, { error: "not found" });
      return send(res, 200, JSON.parse(await readFile(nb.chatHistory, "utf8")));
    }
  }

  send(res, 404, { error: `no route for ${method} ${url.pathname}` });
}

function streamChat(
  res: ServerResponse,
  workspaceId: string,
  notebookId: string,
  prompt: string,
): Promise<void> {
  return streamRun(res, (onEvent) => agent.run(workspaceId, notebookId, prompt, onEvent));
}

/** Shared SSE runner for any agent operation. */
async function streamRun(
  res: ServerResponse,
  run: (onEvent: (event: unknown) => void) => Promise<AgentRunResult>,
  onSuccess?: () => Promise<void>,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await run((event) => sendEvent("pi", event));
    if (onSuccess) await onSuccess();
    // `contextSaved` is the explicit signal that save_context ran this turn;
    // `onboarding` is the post-turn workspace status.
    sendEvent("done", {
      text: result.text,
      contextSaved: result.contextSaved,
      reportSaved: result.reportSaved,
      onboarding: result.onboarding,
    });
  } catch (err) {
    sendEvent("error", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

function readBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const buf = await readBuffer(req);
  if (buf.length === 0) return {} as T;
  return JSON.parse(buf.toString("utf8")) as T;
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
