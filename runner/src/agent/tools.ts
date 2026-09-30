import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { newId } from "../ids.js";
import { withDuckdbLock } from "../workspace/ducklock.js";
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
  config: Config;
  registry: RegistryProjection;
  /** Called when the agent commits workspace context (workspace scope only). */
  onContextSaved?: () => Promise<void>;
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
      "Write the finalized workspace context to memory/onboarding_context.md and mark " +
      "onboarding complete. Call this ONLY after the user has confirmed your summary or " +
      "answered your questions. Include a short 'Open questions' section for anything " +
      "still unresolved. Do not write onboarding_context.md directly with other tools.",
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
      "freeform static HTML/SVG (put the markup in spec.html). See ADR 0004.",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("component"), Type.Literal("artifact")]),
      title: Type.String(),
      spec: Type.Object({}, { additionalProperties: true }),
      position: Type.Optional(Type.Object({}, { additionalProperties: true })),
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
      return {
        content: [{ type: "text", text: `Widget ${id} saved (${params.type}).` }],
        details: { widgetId: id },
      };
    },
  });

  return [duckdbQuery, registerDataset, suggestAnalysis, saveContext, writeWidget];
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
