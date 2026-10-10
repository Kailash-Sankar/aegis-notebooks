export interface Workspace {
  id: string;
  name: string;
  path: string;
  ownerId: string;
  status: "active" | "archived";
  createdAt: string;
}

export interface Notebook {
  id: string;
  workspaceId: string;
  title: string;
  ownerId: string;
  lastActive: string | null;
}

export type WidgetType = "component" | "artifact";

/** Shape the agent writes via the write_widget tool (see ADR 0004). */
export interface WidgetSpecBody {
  title?: string;
  /** SQL run live by a component widget. */
  query?: string;
  /** Inline data, used when query is absent. */
  data?: Record<string, unknown>[];
  chart?: {
    type?: "bar" | "line" | "area" | "pie" | "kpi" | "table" | "stackedBar" | "heatmap";
    x?: string;
    y?: string;
    /** Optional second series (e.g. revenue vs pipeline). */
    y2?: string;
    /** stackedBar: columns to stack. Inferred from numeric columns when omitted. */
    series?: string[];
    /** heatmap: column holding the cell value. Defaults to `y`. */
    value?: string;
    /** table: explicit column order. Defaults to the query's columns. */
    columns?: string[];
  };
  /** Freeform markup for artifact widgets. */
  html?: string;
  /** Explicit iframe height in px for artifact widgets. */
  height?: number;
}

/**
 * Canvas placement on a 12-column grid. `w` is the column span, `h` a row
 * hint. The canvas honors `x`/`w` for columns and orders by `y`.
 */
export interface WidgetLayout {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface Widget {
  id: string;
  notebookId: string;
  type: WidgetType;
  spec: WidgetSpecBody;
  position: Record<string, unknown> | null;
  updatedAt: string;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
  rowCount: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface DataFile {
  name: string;
  bytes: number;
  modified: string;
}

export interface OnboardingStatus {
  onboarded: boolean;
  stale: boolean;
  lastOnboardedAt: string | null;
  tables: number;
}

/** Result of one streamed agent turn (the SSE `done` event). */
export interface AgentRunResult {
  /** Final assistant text for the turn. */
  text: string;
  /** Explicit signal that the agent called save_context this turn. */
  contextSaved: boolean;
  /** Explicit signal that the agent wrote a full-page report this turn. */
  reportSaved: boolean;
  /** Workspace onboarding status after the turn. */
  onboarding: OnboardingStatus;
}

/** Metadata for a full-page static report. */
export interface ReportMeta {
  id: string;
  notebookId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Metadata plus body of a full-page static report. */
export interface Report extends ReportMeta {
  html: string;
}

export interface MetadataTable {
  file?: string;
  rowCount?: number;
  columns?: Array<{ name: string; type: string }>;
}

export interface SuggestedAnalysis {
  id: string;
  title: string;
  prompt: string;
  createdAt: string;
}

/** A background-computed headline finding (aggregated_insights). */
export interface Insight {
  kind: string;
  channel_id: number | string;
  metric: string;
  value: number;
  headline: string;
  as_of: string;
}

/** Local hydration cache metadata (a window of the warehouse as Parquet). */
export interface HydrationManifest {
  workspaceId: string;
  asOf: string;
  window: { from: string; to: string; days: number };
  tables: Record<
    string,
    { view: string; watermark: string; partitions: Record<string, unknown> }
  >;
  createdAt: string;
}

export interface WorkspaceContext {
  status: OnboardingStatus;
  onboardingContext: string;
  userNotes: string;
  metadataSchema: { version?: number; tables?: Record<string, MetadataTable> } | null;
  suggestedAnalyses?: SuggestedAnalysis[];
}
