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
    type?: "bar" | "line" | "area" | "pie";
    x?: string;
    y?: string;
    /** Optional second series (e.g. revenue vs pipeline). */
    y2?: string;
  };
  /** Freeform markup for artifact widgets. */
  html?: string;
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

export interface WorkspaceContext {
  status: OnboardingStatus;
  onboardingContext: string;
  userNotes: string;
  metadataSchema: { version?: number; tables?: Record<string, MetadataTable> } | null;
  suggestedAnalyses?: SuggestedAnalysis[];
}
