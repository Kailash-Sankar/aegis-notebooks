import "./env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { currentUser } from "./auth/current-user.js";
import { createRawStore } from "./raw/store.js";
import { createBroker } from "./transport/broker.js";
import { publishManifest, startChunkBridge } from "./ingest/bridge.js";
import { runIngest } from "./ingest/gateway.js";
import { HttpSourceClient } from "./sources/connector.js";
import { readContract } from "./sources/contract.js";
import { readState, writeState } from "./sources/state.js";
import { serve } from "inngest/node";
import { createWarehouse } from "./warehouse/client.js";
import { processManifest, type LoaderDeps } from "./warehouse/loader.js";
import { createIngestWorkflows, INGEST_EVENT } from "./workflows/inngest.js";
import { withTimeout } from "./util/timeout.js";
import { hydrate } from "./hydrate/hydration.js";
import { readManifest } from "./hydrate/manifest.js";
import { createHydrateViews } from "./hydrate/views.js";
import { listInsights } from "./insights/insights.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { createJobs } from "./scheduler/jobs.js";
import { initTelemetry, telemetry } from "./telemetry/metrics.js";

const config = loadConfig();
const registry = createRegistry(config);
const backup = new BackupService(createBackupStore(config), registry);
const quota = new QuotaService(config);
const workspaces = new WorkspaceManager(config, registry);
const agent = new AgentRunner(config, registry, workspaces);
const deps: IngestDeps = { workspaces, registry, backup, quota };
const raw = createRawStore(config);
const broker = createBroker(config);
const warehouse = createWarehouse(config);
const loaderDeps: LoaderDeps = { warehouse, raw, workspaces };
const ingest = createIngestWorkflows(loaderDeps, {
  ...(config.INNGEST_BASE_URL ? { baseUrl: config.INNGEST_BASE_URL } : {}),
  ...(config.INNGEST_EVENT_KEY ? { eventKey: config.INNGEST_EVENT_KEY } : {}),
});
const inngestHandler = serve({
  client: ingest.inngest,
  functions: ingest.functions,
});
const scheduler = new Scheduler({
  stateDir: join(config.workspacesRootAbs, ".scheduler"),
  tickMs: config.SCHEDULER_TICK_MS,
  log: (message) => console.log(message),
});
for (const job of createJobs({ config, warehouse, workspaces })) {
  scheduler.register(job);
}
initTelemetry(config);

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

  // Infra setup is best-effort and must never block the HTTP server from
  // coming up. The Kafka consumer-group join in particular can take tens of
  // seconds; the query/health endpoints should not wait on it.
  void raw.ensureReady().catch((err) => {
    console.warn("[raw] could not ensure bucket (raw landing will fail):", err);
  });
  void broker.connect().catch((err) => {
    console.warn("[broker] could not connect:", err);
  });
  // The consumer side of the chunk bridge. When Inngest is configured the
  // manifest becomes an event that starts the load workflow; otherwise (dev
  // without Inngest) we load inline so the pipeline still completes.
  void startChunkBridge(broker, async (manifest) => {
    if (config.inngestEnabled) {
      try {
        // The Inngest SDK's send can hang (e.g. a busy dev server) and would
        // otherwise stall the Kafka consumer. Bound it and fall back to inline
        // processing; loading is idempotent, so a late duplicate is harmless.
        await withTimeout(
          ingest.inngest.send({ name: INGEST_EVENT, data: manifest }),
          4000,
          "inngest.send",
        );
        return;
      } catch (err) {
        console.warn(
          "[bridge] inngest send failed/slow; loading inline:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Never let one bad manifest stall the Kafka consumer. Terminal failures
    // (missing/drifted contract) are logged; DLQ routing is a later slice.
    try {
      const result = await processManifest(loaderDeps, manifest);
      console.log(
        `[loader] ${result.loaded.table} +${result.loaded.rows} rows -> ` +
          `${result.tables.join(", ") || "(no transforms)"}`,
      );
    } catch (err) {
      console.warn(
        `[bridge] load failed for ${manifest.source}/${manifest.dataset}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }).catch((err) => {
    console.warn("[bridge] failed to subscribe:", err);
  });

  if (config.schedulerEnabled) {
    void scheduler.start().catch((err) => {
      console.warn("[scheduler] failed to start:", err);
    });
  }

  console.log(
    `[runner] registry=${config.registryEnabled ? "on" : "off"} ` +
      `backups=${config.backupsEnabled ? "on" : "off"} ` +
      `raw=${raw.enabled ? "on" : "off"} ` +
      `broker=${config.brokerEnabled ? "redpanda" : "memory"} ` +
      `warehouse=${config.clickhouseEnabled ? "clickhouse" : "memory"} ` +
      `inngest=${config.inngestEnabled ? "on" : "inline"} ` +
      `reconciled=${result.workspaces} ws / ${result.notebooks} nb`,
  );

  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    handle(req, res)
      .catch((err) => {
        const status = err instanceof QuotaError ? 413 : 400;
        send(res, status, { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        telemetry().recordHttp(
          req.method ?? "GET",
          path,
          res.statusCode,
          Date.now() - startedAt,
        );
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

  // GET|POST|PUT /api/inngest  -- Inngest function registry + invocation.
  if (parts[0] === "api" && parts[1] === "inngest") {
    inngestHandler(req, res);
    return;
  }

  // GET /scheduler  -- job definitions + recent runs
  if (method === "GET" && parts[0] === "scheduler" && parts.length === 1) {
    return send(res, 200, {
      jobs: scheduler.list(),
      runs: await scheduler.recentRuns(20),
    });
  }

  // POST /scheduler/run/:id  -- trigger a job now (operator)
  if (
    method === "POST" &&
    parts[0] === "scheduler" &&
    parts[1] === "run" &&
    parts[2]
  ) {
    await scheduler.runJob(parts[2]);
    return send(res, 200, { ok: true, jobs: scheduler.list() });
  }

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

    // GET /workspaces/:id/insights  -- background-computed headline findings
    if (method === "GET" && parts[2] === "insights" && parts.length === 3) {
      await workspaces.require(workspaceId);
      return send(res, 200, await listInsights({ warehouse }, workspaceId));
    }

    // GET|POST /workspaces/:id/hydrate  -- cache a warehouse window for DuckDB
    if (parts[2] === "hydrate" && parts.length === 3) {
      await workspaces.require(workspaceId);
      const paths = workspaces.pathsFor(workspaceId);
      if (method === "GET") {
        const manifest = await readManifest(paths.hydrateManifest);
        return manifest
          ? send(res, 200, manifest)
          : send(res, 404, { error: "not hydrated" });
      }
      if (method === "POST") {
        const body = await readJson<{
          days?: number;
          asOf?: string;
          tables?: string[];
        }>(req);
        const manifest = await hydrate(
          { warehouse, paths },
          {
            ...(body.days !== undefined ? { days: body.days } : {}),
            ...(body.asOf !== undefined ? { asOf: body.asOf } : {}),
            ...(body.tables !== undefined ? { tables: body.tables } : {}),
          },
        );
        const views = await createHydrateViews(config, paths, manifest);
        return send(res, 200, { ...manifest, views });
      }
    }

    // POST /workspaces/:id/sources/:source/pull  (operator-only: pull + land)
    if (
      method === "POST" &&
      parts[2] === "sources" &&
      parts[4] === "pull" &&
      parts[3]
    ) {
      const source = parts[3];
      await workspaces.require(workspaceId);
      const paths = workspaces.pathsFor(workspaceId);
      const contract = await readContract(paths.sourceContract(source));
      if (!contract) {
        return send(res, 404, { error: `no contract for source "${source}"` });
      }
      const state = await readState(paths.sourceState(source));
      const landed: Array<{ id: string; deduped: boolean }> = [];
      const result = await runIngest(raw, {
        tenantId: currentUser().id,
        workspaceId,
        contract,
        client: new HttpSourceClient(contract.baseUrl),
        state,
        onManifest: async (manifest, deduped) => {
          landed.push({ id: manifest.id, deduped });
          telemetry().recordChunk(manifest.rows, deduped);
          await publishManifest(broker, manifest);
        },
      });
      await writeState(paths.sourceState(source), result.state);
      return send(res, 200, {
        source,
        chunks: result.chunks,
        rows: result.rows,
        watermark: result.state.watermark,
        landed,
      });
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
