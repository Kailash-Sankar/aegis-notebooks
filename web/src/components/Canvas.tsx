import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { listWidgets } from "../api.js";
import type { Widget } from "../types.js";
import { ComponentWidget } from "./ComponentWidget.js";
import { ArtifactWidget } from "./ArtifactWidget.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

/**
 * Dynamic canvas. Fixed React components are the default; freeform artifacts
 * render sandboxed (ADR 0004). Each widget is isolated by an error boundary so
 * one bad spec cannot blank the whole canvas.
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    listWidgets(workspaceId, notebookId)
      .then((list) => {
        setWidgets(list);
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

  return (
    <Stack direction="vertical" height="100%">
      <div className="aegis-pane-header">
        <Text type="label" color="secondary">
          Canvas · {widgets.length} widget{widgets.length === 1 ? "" : "s"}
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
          <Grid columns={{ minWidth: 420, max: 2 }} gap={4}>
            {widgets.map((w) => (
              <ErrorBoundary key={w.id} label={`Widget "${w.spec.title ?? w.id}"`}>
                {w.type === "artifact" ? (
                  <ArtifactWidget widget={w} />
                ) : (
                  <ComponentWidget workspaceId={workspaceId} widget={w} />
                )}
              </ErrorBoundary>
            ))}
          </Grid>
        </Stack>
      </div>
    </Stack>
  );
}
