import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { newId } from "../ids.js";
import { withDuckdbLock } from "../workspace/ducklock.js";
import { writeReport } from "../workspace/reports.js";
import { HttpSourceClient } from "../sources/connector.js";
import { discover } from "../sources/discover.js";
import {
  parseContract,
  schemaFingerprint,
  writeContract,
} from "../sources/contract.js";
import { validateContractSchema } from "../sources/contract-schema.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import type { RegistryProjection } from "../registry/pocketbase.js";
import type { WidgetSpec } from "../types.js";

const execFileAsync = promisify(execFile);

export interface ToolContext {
  workspaceId: string;
  notebookId: string;
  workspaceRoot: string;
  duckdbPath: string;
  assetsDir: string;
  /** Notebook reports directory (`reports/`); used by `write_report`. */
  reportsDir: string;
  /** Workspace sources directory (`sources/`); used by source-contract tools. */
  sourcesDir: string;
  config: Config;
  registry: RegistryProjection;
  /** Called when the agent commits workspace context (workspace scope only). */
  onContextSaved?: () => Promise<void>;
  /** Called after a full-page report is persisted (notebook scope only). */
  onReportSaved?: (reportId: string) => Promise<void>;
}

const MAX_OUTPUT_BYTES = 200_000;

/**
 * Analytics tools exposed to the agent. Data discovery otherwise happens via
 * the built-in `bash` tool calling `duckdb-cli` (see docs/architecture.md).
 */
export function createAnalyticsTools(ctx: ToolContext) {
  const duckdbQuery = defineTool({
    name: "duckdb_query",
    label: "DuckDB Query",
    description:
      "Run a read-only SQL query against the workspace DuckDB database and return JSON rows. " +
      "Use information_schema and DESCRIBE for discovery. Results are capped; add LIMIT for large tables.",
    parameters: Type.Object({
      sql: Type.String({ description: "SQL to execute against the workspace database." }),
    }),
    // DuckDB takes an exclusive file lock; never run two queries concurrently.
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      try {
        const { stdout } = await withDuckdbLock(ctx.duckdbPath, () =>
          execFileAsync(
            ctx.config.DUCKDB_CLI,
            [ctx.duckdbPath, "-json", "-c", params.sql],
            { maxBuffer: MAX_OUTPUT_BYTES, cwd: ctx.workspaceRoot },
          ),
        );
        const text = stdout.length > MAX_OUTPUT_BYTES
          ? `${stdout.slice(0, MAX_OUTPUT_BYTES)}\n[truncated]`
          : stdout;
        return { content: [{ type: "text", text: text || "(no rows)" }], details: undefined };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new Error(`duckdb_query failed: ${e.stderr ?? e.message ?? String(err)}`);
      }
    },
  });

  const registerDataset = defineTool({
    name: "register_dataset",
    label: "Register Dataset",
    description:
      "Create or replace a DuckDB view over a file in data/ and record its schema in " +
      "memory/metadata_schema.json. Call this for each uploaded file before analyzing or " +
      "charting it.",
    parameters: Type.Object({
      name: Type.String({ description: "View name (lowercase snake_case)." }),
      file: Type.String({ description: "File name within data/ (e.g. people.csv)." }),
      description: Type.Optional(Type.String({ description: "What the dataset contains." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const fileName = basename(params.file);
      const absPath = join(ctx.workspaceRoot, "data", fileName);
      if (!existsSync(absPath)) {
        throw new Error(`File not found in data/: ${fileName}`);
      }
      const view = sanitizeIdentifier(params.name);
      const reader = readerFor(fileName);
      const rel = `data/${fileName.replace(/'/g, "''")}`;

      const { columns, rowCount } = await withDuckdbLock(ctx.duckdbPath, async () => {
        await execFileAsync(
          ctx.config.DUCKDB_CLI,
          [
            ctx.duckdbPath,
            "-c",
            `CREATE OR REPLACE VIEW "${view}" AS SELECT * FROM ${reader}('${rel}')`,
          ],
          { cwd: ctx.workspaceRoot },
        );
        const cols = await describeView(ctx, view);
        const count = await countView(ctx, view);
        return { columns: cols, rowCount: count };
      });

      await recordInMetadata(ctx, {
        name: view,
        file: fileName,
        reader,
        columns,
        rowCount,
        description: params.description ?? null,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Registered view "${view}" over data/${fileName} ` +
              `(${rowCount} rows, ${columns.length} columns).\n` +
              columns.map((c) => `- ${c.name} ${c.type}`).join("\n"),
          },
        ],
        details: { view, fileName, rowCount, columns },
      };
    },
  });

  const suggestAnalysis = defineTool({
    name: "suggest_analysis",
    label: "Suggest Analysis",
    description:
      "Record one concrete suggested analysis or dashboard for the workspace, so the " +
      "user can start it with one click. Call this for each suggestion after onboarding.",
    parameters: Type.Object({
      title: Type.String({ description: "Short name, e.g. 'Revenue by region'." }),
      prompt: Type.String({
        description: "One-line instruction to build this analysis.",
      }),
    }),
    // Read-modify-write of a shared file: serialize so parallel calls can't
    // interleave and corrupt it.
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const file = join(ctx.workspaceRoot, "memory", "suggested_analyses.json");
      await withDuckdbLock(file, async () => {
        let list: unknown[] = [];
        if (existsSync(file)) {
          try {
            const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
            if (Array.isArray(parsed)) list = parsed;
          } catch {
            list = [];
          }
        }
        const exists = list.some(
          (a) => (a as { title?: string }).title === params.title,
        );
        if (!exists) {
          list.push({
            id: newId(),
            title: params.title,
            prompt: params.prompt,
            createdAt: new Date().toISOString(),
          });
          await writeFile(file, JSON.stringify(list, null, 2), "utf8");
        }
      });
      return {
        content: [{ type: "text", text: `Suggested analysis recorded: ${params.title}` }],
        details: undefined,
      };
    },
  });

  const saveContext = defineTool({
    name: "save_context",
    label: "Save Context",
    description:
      "Write the workspace context to memory/onboarding_context.md and mark onboarding " +
      "complete. Call this after the user confirms a summary or answers a question, and " +
      "call it again whenever they confirm a new fact or correction (re-read the current " +
      "file first, then resend the full markdown) so confirmed context is never lost " +
      "between turns. Include a short 'Open questions' section for anything still " +
      "unresolved. Do not write onboarding_context.md directly with other tools.",
    parameters: Type.Object({
      markdown: Type.String({
        description: "The full onboarding_context.md content (markdown).",
      }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const file = join(ctx.workspaceRoot, "memory", "onboarding_context.md");
      await withDuckdbLock(file, () => writeFile(file, params.markdown, "utf8"));
      await ctx.onContextSaved?.();
      return {
        content: [{ type: "text", text: "Workspace context saved." }],
        details: undefined,
      };
    },
  });

  const writeWidget = defineTool({
    name: "write_widget",
    label: "Write Widget",
    description:
      "Persist a dashboard widget for the current notebook. Use type=component for a live, " +
      "data-bound chart (include the SQL query and chart config in spec). Use type=artifact for " +
      "freeform static HTML/SVG (put the markup in spec.html). See ADR 0004. " +
      "The canvas is a 12-column grid: set `position` so widgets lay out as intended. " +
      "Omitted position defaults to half width. Charts are usually w=6 or w=4; KPI rows and " +
      "wide tables are w=12.",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("component"), Type.Literal("artifact")]),
      title: Type.String(),
      spec: Type.Object({}, { additionalProperties: true }),
      position: Type.Optional(
        Type.Object(
          {
            x: Type.Optional(
              Type.Number({ description: "Starting column (0-11). Default: auto." }),
            ),
            y: Type.Optional(
              Type.Number({ description: "Row order. Widgets are placed top-to-bottom by y." }),
            ),
            w: Type.Optional(
              Type.Number({ description: "Column span, 1-12. Use 12 for full width." }),
            ),
            h: Type.Optional(
              Type.Number({
                description:
                  "Height hint (rows). ~1 for KPI strips, 3 for standard charts; map rows to ~120px.",
              }),
            ),
          },
          {
            description:
              "12-column grid placement. Example full-width KPI row: {x:0,y:0,w:12,h:1}.",
            additionalProperties: false,
          },
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      const id = newId();
      const spec = params.spec as Record<string, unknown>;
      const position = (params.position as Record<string, unknown> | undefined) ?? null;
      const widget: WidgetSpec = {
        id,
        notebookId: ctx.notebookId,
        type: params.type,
        spec: { title: params.title, ...spec },
        position,
        updatedAt: new Date().toISOString(),
      };
      await ctx.registry.upsertWidget(widget);

      // Artifacts are also persisted to the workspace so it stays self-contained (ADR 0004).
      if (params.type === "artifact" && typeof spec.html === "string") {
        await writeFile(join(ctx.assetsDir, `${id}.html`), spec.html, "utf8");
      }
      const size =
        position && typeof position.w === "number"
          ? `, w=${position.w}${typeof position.h === "number" ? ` h=${position.h}` : ""}`
          : "";
      return {
        content: [{ type: "text", text: `Widget ${id} saved (${params.type}${size}).` }],
        details: { widgetId: id },
      };
    },
  });

  const writeReportTool = defineTool({
    name: "write_report",
    label: "Write Report",
    description:
      "Persist a full-page static report for the current notebook. The report is a " +
      "self-contained HTML fragment (body content) rendered in a centred 920px column " +
      "with a built-in theme. It is static -- bake the numbers in with SQL first " +
      "(no scripts, no live queries). Prefer this over `write_widget` when the user " +
      "asks for a report/briefing; use `write_widget` for dashboard tiles. Pass `id` " +
      "to replace an existing report, or omit it to create a new one.\n\n" +
      "Write semantic HTML: <h1> title, <h2> sections, <p> prose, <table>, <ul>, " +
      "<blockquote>, <code>, and inline <svg> for charts (use viewBox, no fixed px " +
      "width). Base element styles are provided -- do NOT restyle h1/h2/p/table or " +
      "set page width/padding; add <style> only for chart-specific bits. Prefer the " +
      "provided kit: `.kpis` > `.kpi` > `.kpi-value` + `.kpi-label` for metric " +
      "strips; `.card` and `.callout` for boxed content; `.grid-2` for two-column " +
      "layouts; `.muted` for secondary text; `.chart` around SVGs. Use the theme " +
      "accent via `var(--rp-accent)` (default #6366f1) instead of ad-hoc palettes.",
    parameters: Type.Object({
      title: Type.String({ description: "Report title, shown in the report list." }),
      html: Type.String({
        description:
          "Self-contained HTML body fragment: semantic sections, prose, tables, " +
          "inline SVG, and optional <style> for chart specifics. Use the report kit " +
          "classes (.kpis/.kpi/.kpi-value/.kpi-label, .card, .callout, .grid-2, " +
          ".muted, .chart). Do not include <html>/<head>/<body>, <script>, page " +
          "width/padding, or base-element overrides; the app wraps and themes it.",
      }),
      id: Type.Optional(
        Type.String({ description: "Existing report id to replace." }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const meta = await writeReport(ctx.reportsDir, {
        id: params.id,
        notebookId: ctx.notebookId,
        title: params.title,
        html: params.html,
      });
      await ctx.onReportSaved?.(meta.id);
      return {
        content: [
          { type: "text", text: `Report "${meta.title}" saved (${meta.id}).` },
        ],
        details: { reportId: meta.id },
      };
    },
  });

  const discoverSource = defineTool({
    name: "discover_source",
    label: "Discover Source",
    description:
      "Sample a source HTTP API and deterministically infer a draft SourceContract " +
      "(column types, null ratios, candidate primary keys, candidate cursor fields). " +
      "Call this during onboarding before `write_source_contract`. Returns the draft as JSON.",
    parameters: Type.Object({
      source: Type.String({ description: "Source name (lowercase snake_case)." }),
      dataset: Type.String({ description: "Dataset/table name, e.g. stream_events." }),
      baseUrl: Type.String({ description: "Base URL of the source API, e.g. http://mock-source:8099." }),
      endpoint: Type.String({ description: "Request path, e.g. /v1/stream_events." }),
      limit: Type.Optional(Type.Number({ description: "Sample size (default 200)." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const client = new HttpSourceClient(params.baseUrl);
      const page = await client.fetchPage({
        endpoint: params.endpoint,
        cursor: null,
        limit: params.limit ?? 200,
      });
      if (page.data.length === 0) {
        throw new Error("source returned no rows to sample");
      }
      const result = discover({
        source: params.source,
        dataset: params.dataset,
        baseUrl: params.baseUrl,
        endpoint: params.endpoint,
        pageSize: params.limit ?? 200,
        rows: page.data,
      });
      const summary = {
        rowCount: result.rowCount,
        candidateKeys: result.candidateKeys,
        candidateCursorFields: result.candidateCursorFields,
        warnings: result.warnings,
        columns: result.columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullRatio: c.nullRatio,
          unique: c.unique,
        })),
        draft: result.draft,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        details: undefined,
      };
    },
  });

  const writeSourceContract = defineTool({
    name: "write_source_contract",
    label: "Write Source Contract",
    description:
      "Validate and persist a SourceContract (JSON string) to " +
      "sources/<source>/contract.json. It must pass the published JSON Schema " +
      "(sources/contract.schema.json). Start from the `discover_source` draft and " +
      "adjust the key, cursorField/eventTime, and PII flags. Ask the user about ambiguity " +
      "before committing.",
    parameters: Type.Object({
      contractJson: Type.String({
        description: "The SourceContract serialised as a JSON string.",
      }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      let raw: unknown;
      try {
        raw = JSON.parse(params.contractJson);
      } catch (err) {
        throw new Error(
          `contractJson is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const schema = validateContractSchema(raw);
      if (!schema.valid) {
        throw new Error(
          `contract failed schema validation: ${schema.errors.join("; ")}`,
        );
      }
      const contract = parseContract(raw);
      await writeContract(join(ctx.sourcesDir, contract.source, "contract.json"), contract);
      const fingerprint = schemaFingerprint(contract);
      return {
        content: [
          {
            type: "text",
            text:
              `Source contract for "${contract.source}/${contract.dataset}" saved ` +
              `(${fingerprint}). Pull it with ` +
              `POST /workspaces/${ctx.workspaceId}/sources/${contract.source}/pull.`,
          },
        ],
        details: {
          source: contract.source,
          dataset: contract.dataset,
          fingerprint,
        },
      };
    },
  });

  return [
    duckdbQuery,
    registerDataset,
    suggestAnalysis,
    saveContext,
    writeWidget,
    writeReportTool,
    discoverSource,
    writeSourceContract,
  ];
}

type Column = { name: string; type: string };

interface MetadataEntry {
  name: string;
  file: string;
  reader: string;
  columns: Column[];
  rowCount: number;
  description: string | null;
}

function sanitizeIdentifier(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const safe = cleaned.replace(/^([0-9])/, "v_$1") || "dataset";
  return safe;
}

function readerFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".parquet")) return "read_parquet";
  if (lower.endsWith(".json") || lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
    return "read_json_auto";
  }
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) {
    return "read_csv_auto";
  }
  throw new Error(`Unsupported file type: ${fileName}`);
}

async function describeView(ctx: ToolContext, view: string): Promise<Column[]> {
  const { stdout } = await execFileAsync(
    ctx.config.DUCKDB_CLI,
    [ctx.duckdbPath, "-json", "-c", `DESCRIBE "${view}"`],
    { cwd: ctx.workspaceRoot, maxBuffer: MAX_OUTPUT_BYTES },
  );
  const rows = JSON.parse(stdout || "[]") as Array<{ column_name: string; column_type: string }>;
  return rows.map((r) => ({ name: r.column_name, type: r.column_type }));
}

async function countView(ctx: ToolContext, view: string): Promise<number> {
  const { stdout } = await execFileAsync(
    ctx.config.DUCKDB_CLI,
    [ctx.duckdbPath, "-json", "-c", `SELECT count(*) AS n FROM "${view}"`],
    { cwd: ctx.workspaceRoot, maxBuffer: MAX_OUTPUT_BYTES },
  );
  const rows = JSON.parse(stdout || "[]") as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function recordInMetadata(ctx: ToolContext, entry: MetadataEntry): Promise<void> {
  const path = join(ctx.workspaceRoot, "memory", "metadata_schema.json");
  let current: { version: number; tables: Record<string, MetadataEntry> } = {
    version: 1,
    tables: {},
  };
  if (existsSync(path)) {
    try {
      current = JSON.parse(await readFile(path, "utf8")) as typeof current;
      current.tables ??= {};
    } catch {
      // fall back to a fresh registry
    }
  }
  current.tables[entry.name] = entry;
  await writeFile(path, JSON.stringify(current, null, 2), "utf8");
}
