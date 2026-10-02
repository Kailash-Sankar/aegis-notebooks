import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RefreshCw } from "lucide-react";
import GridLayout, {
  useContainerWidth,
  type Layout,
  type LayoutItem,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { Button } from "@astryxdesign/core/Button";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { listWidgets, saveLayout } from "../api.js";
import type { Widget } from "../types.js";
import { ComponentWidget } from "./ComponentWidget.js";
import { ArtifactWidget } from "./ArtifactWidget.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

/** 12-column grid geometry. `h: 1` ~= 100px, matching the agent's tool docs. */
export const GRID_COLS = 12;
export const ROW_HEIGHT = 100;
export const GRID_MARGIN: readonly [number, number] = [16, 16];

export interface NormalizedLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Read a widget's `position` into a concrete 12-column grid placement. */
export function normalizeLayout(
  position: Record<string, unknown> | null,
): NormalizedLayout | null {
  if (!position) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const w = clamp(num(position.w) ?? 6, 1, 12);
  return {
    x: clamp(num(position.x) ?? 0, 0, 12 - w),
    y: num(position.y) ?? 0,
    h: clamp(num(position.h) ?? 3, 1, 24),
    w,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Convert stored widget positions to a react-grid-layout. Widgets without a
 * position are stacked below the others at the default half width.
 */
export function layoutFromWidgets(widgets: Widget[]): Layout {
  let fallbackY = 0;
  return widgets.map((widget) => {
    const l = normalizeLayout(widget.position);
    const base: LayoutItem = l
      ? { i: widget.id, x: l.x, y: l.y, w: l.w, h: l.h }
      : { i: widget.id, x: 0, y: (fallbackY += 3), w: 6, h: 3 };
    return { ...base, minW: 2, minH: 1 };
  });
}

/** Total cell height in px for a layout item. */
function itemPixelHeight(h: number): number {
  return h * ROW_HEIGHT + Math.max(0, h - 1) * GRID_MARGIN[1];
}

/**
 * Dynamic, draggable canvas. Components and sandboxed artifacts are laid out on
 * a 12-column grid. The agent proposes a `position` (see `write_widget`); the
 * user can drag and resize, and the layout is persisted back to the registry.
 */
export function Canvas({
  workspaceId,
  notebookId,
  refreshToken,
}: {
  workspaceId: string;
  notebookId: string;
  refreshToken: number;
}) {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [layout, setLayout] = useState<Layout>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { width, containerRef, mounted } = useContainerWidth();

  // Keep the latest layout reachable from callbacks without re-subscribing.
  const layoutRef = useRef<Layout>([]);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const reload = useCallback(() => {
    setLoading(true);
    listWidgets(workspaceId, notebookId)
      .then((list) => {
        setWidgets(list);
        setLayout(layoutFromWidgets(list));
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, [workspaceId, notebookId]);

  useEffect(() => {
    reload();
  }, [reload, refreshToken]);

  const persist = useCallback(
    (next: Layout) => {
      setLayout(next);
      saveLayout(
        workspaceId,
        notebookId,
        next.map(({ i, x, y, w, h }) => ({ id: i, x, y, w, h })),
      ).catch((err: unknown) => {
        console.error("[canvas] failed to save layout", err);
      });
    },
    [workspaceId, notebookId],
  );

  /** Grow a widget's row span so its reported content height fits. */
  const growForContent = useCallback(
    (id: string, contentPx: number) => {
      const prev = layoutRef.current;
      const item = prev.find((l) => l.i === id);
      if (!item) return;
      const rows = Math.min(
        24,
        Math.max(
          item.h,
          Math.ceil(
            (contentPx + 64 + GRID_MARGIN[1]) / (ROW_HEIGHT + GRID_MARGIN[1]),
          ),
        ),
      );
      if (rows <= item.h) return;
      persist(prev.map((l) => (l.i === id ? { ...l, h: rows } : l)));
    },
    [persist],
  );

  const cellHeight = useMemo(() => {
    const byId = new Map(layout.map((l) => [l.i, l.h]));
    return (id: string) => itemPixelHeight(byId.get(id) ?? 3);
  }, [layout]);

  return (
    <Stack direction="vertical" height="100%">
      <div className="aegis-pane-header">
        <Text type="label" color="secondary">
          Canvas · {widgets.length} widget{widgets.length === 1 ? "" : "s"} · drag
          to move · resize corner
        </Text>
        <Button
          label="Refresh"
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={15} />}
          isLoading={loading}
          onClick={reload}
        />
      </div>

      <div className="aegis-scroll">
        <Stack padding={4} gap={4}>
          {error && <div className="aegis-error">{error}</div>}
          {!error && widgets.length === 0 && !loading && (
            <Text color="secondary">
              No widgets yet. Ask the agent in chat to build a chart or report.
            </Text>
          )}
          <div ref={containerRef} className="aegis-canvas-grid">
            {mounted && width > 0 && layout.length > 0 && (
              <GridLayout
                layout={layout}
                width={width}
                gridConfig={{
                  cols: GRID_COLS,
                  rowHeight: ROW_HEIGHT,
                  margin: [GRID_MARGIN[0], GRID_MARGIN[1]],
                  containerPadding: [0, 0],
                }}
                dragConfig={{
                  enabled: true,
                  bounded: false,
                  handle: ".aegis-drag-handle",
                  cancel: "button, a, input, textarea, select, iframe",
                  threshold: 3,
                }}
                resizeConfig={{ enabled: true, handles: ["se"] }}
                onLayoutChange={setLayout}
                onDragStop={(next) => persist(next)}
                onResizeStop={(next) => persist(next)}
              >
                {widgets.map((w) => (
                  <div key={w.id} className="aegis-widget">
                    <ErrorBoundary label={`Widget "${w.spec.title ?? w.id}"`}>
                      {w.type === "artifact" ? (
                        <ArtifactWidget
                          widget={w}
                          maxHeight={cellHeight(w.id)}
                          onContentHeight={growForContent}
                        />
                      ) : (
                        <ComponentWidget
                          workspaceId={workspaceId}
                          widget={w}
                          maxHeight={cellHeight(w.id)}
                          onContentHeight={growForContent}
                        />
                      )}
                    </ErrorBoundary>
                  </div>
                ))}
              </GridLayout>
            )}
          </div>
        </Stack>
      </div>
    </Stack>
  );
}
