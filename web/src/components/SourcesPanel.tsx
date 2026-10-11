import { useCallback, useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Database, Plus, RefreshCw, Trash2 } from "lucide-react";
import { deleteSource, listSources, pullSource, runSchedulerJob } from "../api.js";
import type { SourceSummary } from "../types.js";
import { ConnectSourceDialog } from "./ConnectSourceDialog.js";

/**
 * Warehouse pull sources: connect, sync, and refresh the marketing layers
 * (prepared/aggregated) + local DuckDB hydration, all from the workspace view.
 */
export function SourcesPanel({
  workspaceId,
  onChanged,
  onAvailability,
}: {
  workspaceId: string;
  onChanged?: () => void;
  onAvailability?: (has: boolean) => void;
}) {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busySource, setBusySource] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await listSources(workspaceId);
      setSources(list);
      onAvailability?.(list.length > 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId, onAvailability]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync(source: string) {
    setBusySource(source);
    setError(null);
    setNotice(null);
    try {
      const result = await pullSource(workspaceId, source);
      setNotice(
        `Synced ${source}: ${result.rows} row(s) in ${result.chunks} chunk(s)` +
          (result.watermark ? ` (watermark ${result.watermark}).` : "."),
      );
      await load();
      // Rebuild prepared/aggregated + refresh the local DuckDB window.
      await runSchedulerJob("warehouse-refresh");
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySource(null);
    }
  }

  async function refreshWarehouse() {
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      await runSchedulerJob("warehouse-refresh");
      await runSchedulerJob("insights");
      setNotice("Warehouse refreshed; insights recomputed.");
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function remove(source: string) {
    if (!window.confirm(`Remove source "${source}" and its connector state?`)) return;
    try {
      await deleteSource(workspaceId, source);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card>
      <Stack gap={3}>
        <Stack direction="horizontal" gap={2} vAlign="center" justify="between">
          <Text weight="semibold">
            <Database size={15} /> Warehouse sources
          </Text>
          <Stack direction="horizontal" gap={2}>
            <Button
              label="Refresh warehouse"
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={15} />}
              onClick={refreshWarehouse}
              isDisabled={refreshing}
            />
            <Button
              label="Connect source"
              variant="secondary"
              size="sm"
              icon={<Plus size={15} />}
              onClick={() => setDialogOpen(true)}
            />
          </Stack>
        </Stack>

        {sources.length === 0 ? (
          <Text color="secondary">
            No pull sources yet. Connect an external API to ingest it into the
            warehouse (raw → ingested → prepared/aggregated).
          </Text>
        ) : (
          <Stack gap={2}>
            {sources.map((s) => (
              <Stack
                key={s.source}
                direction="horizontal"
                gap={2}
                vAlign="center"
                justify="between"
              >
                <Stack gap={0}>
                  <Text weight="medium">
                    {s.source} · {s.dataset}
                  </Text>
                  <Text type="supporting" color="secondary">
                    {s.endpoint} · auth: {s.authType} · {s.columns} cols · watermark:{" "}
                    {s.watermark ?? "—"}
                  </Text>
                </Stack>
                <Stack direction="horizontal" gap={1} vAlign="center">
                  <Badge
                    label={s.lastSyncAt ? "synced" : "not synced"}
                    variant={s.lastSyncAt ? "success" : "warning"}
                  />
                  <Button
                    label="Sync now"
                    size="sm"
                    variant="secondary"
                    onClick={() => sync(s.source)}
                    isDisabled={busySource === s.source}
                  />
                  <IconButton
                    label="Remove source"
                    icon={<Trash2 size={15} />}
                    onClick={() => remove(s.source)}
                  />
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}

        {notice && (
          <Text type="supporting" color="secondary">
            {notice}
          </Text>
        )}
        {error && <Text color="secondary">⚠ {error}</Text>}
      </Stack>

      <ConnectSourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={workspaceId}
        onSaved={() => {
          void load();
          onChanged?.();
        }}
      />
    </Card>
  );
}
