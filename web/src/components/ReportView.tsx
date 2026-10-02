import { useCallback, useEffect, useState } from "react";
import { Download, Printer, RefreshCw, Trash2 } from "lucide-react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { deleteReport, getReport, listReports } from "../api.js";
import type { Report, ReportMeta } from "../types.js";
import { buildSandboxDoc, SandboxedHtml } from "./SandboxedHtml.js";

/**
 * Full-page static report surface (Tier 1). Reports are self-contained HTML/SVG
 * documents produced by the agent via `write_report`, distinct from canvas
 * tiles. Rendered scriptless in a sandboxed frame; downloadable and printable.
 */
export function ReportView({
  workspaceId,
  notebookId,
  refreshToken,
}: {
  workspaceId: string;
  notebookId: string;
  refreshToken: number;
}) {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listReports(workspaceId, notebookId);
      setReports(list);
      setSelectedId((current) =>
        current && list.some((r) => r.id === current)
          ? current
          : (list[0]?.id ?? null),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, notebookId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  useEffect(() => {
    if (!selectedId) {
      setReport(null);
      return;
    }
    let cancelled = false;
    getReport(workspaceId, notebookId, selectedId)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, notebookId, selectedId, refreshToken]);

  function download() {
    if (!report) return;
    const blob = new Blob([buildSandboxDoc(report.html, false, true)], {
      type: "text/html",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName(report.title)}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function print() {
    if (!report) return;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.open();
    win.document.write(buildSandboxDoc(report.html, false, true));
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }

  async function remove() {
    if (!report) return;
    if (!window.confirm(`Delete report “${report.title}”?`)) return;
    await deleteReport(workspaceId, notebookId, report.id);
    setReport(null);
    setSelectedId(null);
    await reload();
  }

  return (
    <Stack direction="vertical" height="100%">
      <div className="aegis-pane-header">
        <Stack direction="horizontal" gap={2} vAlign="center">
          <Text type="label" color="secondary">
            Report
          </Text>
          {reports.length > 1 ? (
            <select
              className="aegis-report-select"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          ) : report ? (
            <Text weight="medium" maxLines={1}>
              {report.title}
            </Text>
          ) : null}
        </Stack>
        <Stack direction="horizontal" gap={1}>
          <IconButton
            label="Refresh"
            tooltip="Refresh"
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={15} />}
            isLoading={loading}
            onClick={reload}
          />
          <IconButton
            label="Download HTML"
            tooltip="Download HTML"
            variant="ghost"
            size="sm"
            icon={<Download size={15} />}
            isDisabled={!report}
            onClick={download}
          />
          <IconButton
            label="Print / PDF"
            tooltip="Print / PDF"
            variant="ghost"
            size="sm"
            icon={<Printer size={15} />}
            isDisabled={!report}
            onClick={print}
          />
          <IconButton
            label="Delete report"
            tooltip="Delete report"
            variant="ghost"
            size="sm"
            icon={<Trash2 size={15} />}
            isDisabled={!report}
            onClick={remove}
          />
        </Stack>
      </div>

      {error && <div className="aegis-error" style={{ padding: 16 }}>{error}</div>}

      {!report && !error && !loading && (
        <div className="aegis-report-empty">
          <Text weight="semibold">No report yet</Text>
          <Text type="supporting" color="secondary">
            Ask the agent in chat to build a full report — e.g. “Build a Q3
            performance report with charts and commentary”. Reports are
            full-page documents; dashboard tiles live on the Dashboard tab.
          </Text>
        </div>
      )}

      {report && (
        <div className="aegis-report-frame">
          <SandboxedHtml
            key={report.id}
            html={report.html}
            title={report.title}
            allowScripts={false}
            theme
          />
        </div>
      )}
    </Stack>
  );
}

function safeName(title: string): string {
  const cleaned = title.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return cleaned || "report";
}
