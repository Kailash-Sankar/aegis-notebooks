import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { runQuery } from "../api.js";
import type { Widget } from "../types.js";

const COLORS = ["#6366f1", "#14b8a6", "#f97316", "#8b5cf6", "#ef4444", "#22c55e"];
const AXIS = "#71717a";
const GRID = "#e4e4e7";
const TOOLTIP = { background: "#ffffff", border: "1px solid #e4e4e7", borderRadius: 8 };

/**
 * Live, data-bound widget. Runs the widget's SQL against DuckDB and renders a
 * fixed chart type (ADR 0004). Safe by construction: no agent HTML is executed.
 */
export function ComponentWidget({
  workspaceId,
  widget,
  maxHeight,
  onContentHeight,
}: {
  workspaceId: string;
  widget: Widget;
  maxHeight?: number;
  onContentHeight?: (id: string, px: number) => void;
}) {
  const [rows, setRows] = useState<Record<string, unknown>[]>(widget.spec.data ?? []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const query = widget.spec.query;
    if (!query) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    runQuery(workspaceId, query)
      .then((res) => {
        if (!cancelled) setRows(res.rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, widget, nonce]);

  const chart = widget.spec.chart ?? {};
  const chartType = chart.type ?? "bar";
  const x = chart.x ?? guessKey(rows, 0);
  const y = chart.y ?? guessKey(rows, 1);
  const y2 = chart.y2;
  const special =
    chartType === "kpi" ||
    chartType === "table" ||
    chartType === "stackedBar" ||
    chartType === "heatmap";
  const stackSeries = useMemo(
    () => (chartType === "stackedBar" ? stackedSeries(rows, x, chart.series) : []),
    [chartType, rows, x, chart.series],
  );
  // DuckDB returns BIGINT/DECIMAL aggregates as strings; Recharts needs numbers.
  const data = useMemo(() => normalizeRows(rows, [y, y2]), [rows, y, y2]);
  // If the charted column isn't numeric, a table is more useful than a blank chart.
  const isNumeric = useMemo(
    () => data.some((row) => typeof row[y] === "number"),
    [data, y],
  );
  const kpiCount = useMemo(
    () => (chartType === "kpi" ? kpiItems(data, x, y).length : 0),
    [chartType, data, x, y],
  );

  // KPI strips are grid-wrapped, so their height depends on the cell width.
  // Estimate the rows needed and ask the canvas to grow the cell when clipped.
  const kpiRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chartType !== "kpi" || kpiCount === 0) return;
    const node = kpiRef.current;
    if (!node) return;
    const compute = () => {
      const card = 140;
      const gap = 12;
      const cols = Math.max(
        1,
        Math.floor((node.clientWidth + gap) / (card + gap)),
      );
      const rowsNeeded = Math.max(1, Math.ceil(kpiCount / cols));
      const contentH = rowsNeeded * 64 + (rowsNeeded - 1) * gap;
      if (maxHeight !== undefined && contentH + 64 > maxHeight) {
        onContentHeight?.(widget.id, contentH);
      }
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(node);
    return () => observer.disconnect();
  }, [chartType, kpiCount, maxHeight, onContentHeight, widget.id]);
  // The chart fills whatever the canvas grid gives it; measure the body instead
  // of guessing from `position.h`.
  const { ref: chartRef, width, height } = useMeasuredSize<HTMLDivElement>();

  return (
    <Card padding={0} className="aegis-widget-card" style={{ height: "100%" }}>
      <Stack
        className="aegis-drag-handle"
        direction="horizontal"
        gap={2}
        vAlign="center"
        justify="between"
        paddingInline={3}
        paddingBlock={2}
      >
        <Text weight="medium" maxLines={1}>
          {widget.spec.title ?? "Untitled"}
        </Text>
        <IconButton
          label="Re-run query"
          tooltip="Re-run query"
          variant="ghost"
          size="sm"
          isLoading={loading}
          icon={<RefreshCw size={14} />}
          onClick={() => setNonce((n) => n + 1)}
        />
      </Stack>
      <Divider />
      <div className="aegis-widget-body">
        <Stack padding={3} gap={2} height="100%">
          {error && <div className="aegis-error">{error}</div>}
          {!error && data.length === 0 && !loading && (
            <Text type="supporting" color="secondary">
              No rows
            </Text>
          )}
          {!error && data.length > 0 && chartType === "kpi" && (
            <div ref={kpiRef} className="aegis-kpi-wrap">
              <KpiRow rows={data} label={x} value={y} />
            </div>
          )}
          {!error && data.length > 0 && chartType === "table" && (
            <div className="aegis-chart-fill">
              <DataTable
                rows={data}
                columns={chart.columns ?? tableColumns(data)}
              />
            </div>
          )}
          {!error && data.length > 0 && chartType === "stackedBar" && (
            <div ref={chartRef} className="aegis-chart-fill">
              {width > 0 && height > 0 && stackSeries.length > 0 && (
                <StackedBar
                  rows={normalizeRows(rows, stackSeries)}
                  x={x}
                  series={stackSeries}
                  width={width}
                  height={height}
                />
              )}
            </div>
          )}
          {!error && data.length > 0 && chartType === "heatmap" && (
            <div ref={chartRef} className="aegis-chart-fill">
              <Heatmap rows={rows} x={x} y={y} value={chart.value ?? y} />
            </div>
          )}
          {!error && data.length > 0 && !special && isNumeric && (
            <div ref={chartRef} className="aegis-chart-fill">
              {width > 0 && height > 0 && (
                <Chart
                  type={chartType}
                  rows={data}
                  x={x}
                  y={y}
                  y2={y2}
                  width={width}
                  height={height}
                />
              )}
            </div>
          )}
          {!error && data.length > 0 && !special && !isNumeric && (
            <div className="aegis-chart-fill">
              <DataTable rows={data} columns={[x, y, y2]} />
            </div>
          )}
        </Stack>
      </div>
    </Card>
  );
}

/** Coerce numeric strings (e.g. "2840") to numbers for the given keys. */
function normalizeRows(
  rows: Record<string, unknown>[],
  keys: Array<string | undefined>,
): Record<string, unknown>[] {
  const active = keys.filter((k): k is string => Boolean(k));
  if (active.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const key of active) {
      const v = out[key];
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
        out[key] = Number(v);
      }
    }
    return out;
  });
}

function Chart({
  type,
  rows,
  x,
  y,
  y2,
  width,
  height,
}: {
  type: "bar" | "line" | "area" | "pie";
  rows: Record<string, unknown>[];
  x: string;
  y: string;
  y2?: string;
  width: number;
  height: number;
}) {
  const second = Boolean(y2);
  if (type === "line") {
    return (
      <LineChart data={rows} width={width} height={height}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
        <XAxis dataKey={x} stroke={AXIS} fontSize={11} />
        <YAxis stroke={AXIS} fontSize={11} />
        <Tooltip contentStyle={TOOLTIP} />
        {second && <Legend />}
        <Line type="monotone" dataKey={y} stroke="#6366f1" strokeWidth={2} />
        {second && (
          <Line type="monotone" dataKey={y2 as string} stroke="#14b8a6" strokeWidth={2} />
        )}
      </LineChart>
    );
  }
  if (type === "area") {
    return (
      <AreaChart data={rows} width={width} height={height}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
        <XAxis dataKey={x} stroke={AXIS} fontSize={11} />
        <YAxis stroke={AXIS} fontSize={11} />
        <Tooltip contentStyle={TOOLTIP} />
        {second && <Legend />}
        <Area type="monotone" dataKey={y} stroke="#14b8a6" fill="#14b8a633" />
        {second && (
          <Area type="monotone" dataKey={y2 as string} stroke="#6366f1" fill="#6366f133" />
        )}
      </AreaChart>
    );
  }
  if (type === "pie") {
    return (
      <PieChart width={width} height={height}>
        <Tooltip contentStyle={TOOLTIP} />
        <Legend />
        <Pie data={rows} dataKey={y} nameKey={x} outerRadius={90} label>
          {rows.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
      </PieChart>
    );
  }
  return (
    <BarChart data={rows} width={width} height={height}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
      <XAxis dataKey={x} stroke={AXIS} fontSize={11} />
      <YAxis stroke={AXIS} fontSize={11} />
      <Tooltip contentStyle={TOOLTIP} />
      {second && <Legend />}
      <Bar dataKey={y} fill="#6366f1" radius={[3, 3, 0, 0]} />
      {second && <Bar dataKey={y2 as string} fill="#14b8a6" radius={[3, 3, 0, 0]} />}
    </BarChart>
  );
}

/**
 * Track an element's content-box width for non-responsive Recharts charts.
 * Uses a callback ref so it observes the node whenever it mounts (the chart
 * container only appears after rows load, which is after the first commit).
 */
function useMeasuredSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) return;
    const update = () =>
      setSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    observer.current = new ResizeObserver(update);
    observer.current.observe(node);
  }, []);
  return { ref, ...size };
}

function DataTable({
  rows,
  columns,
}: {
  rows: Record<string, unknown>[];
  columns: Array<string | undefined>;
}) {
  const cols = columns.filter((c): c is string => Boolean(c));
  return (
    <div style={{ overflow: "auto" }}>
      <table className="aegis-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{String(row[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Headline metric cards. Rows are `label -> value` when `x`/`y` resolve to
 * distinct columns; otherwise a single row renders one card per column.
 */
function KpiRow({
  rows,
  label,
  value,
}: {
  rows: Record<string, unknown>[];
  label: string;
  value: string;
}) {
  const items = kpiItems(rows, label, value);
  return (
    <div className="aegis-kpi-row">
      {items.map((item, i) => (
        <div className="aegis-kpi-card" key={`${item.label}-${i}`}>
          <div className="aegis-kpi-label">{item.label}</div>
          <div className="aegis-kpi-value">{formatKpi(item.value)}</div>
        </div>
      ))}
    </div>
  );
}

function kpiItems(
  rows: Record<string, unknown>[],
  label: string,
  value: string,
): Array<{ label: string; value: unknown }> {
  const first = rows[0] ?? {};
  const keys = Object.keys(first);
  if (label && value && label !== value && keys.includes(label) && keys.includes(value)) {
    return rows.map((row) => ({ label: String(row[label] ?? ""), value: row[value] }));
  }
  if (rows.length === 1) {
    return keys.map((key) => ({ label: key, value: first[key] }));
  }
  const lk = keys[0];
  const vk = keys[1];
  if (!lk) return [];
  return rows.map((row) => ({ label: String(row[lk] ?? ""), value: vk ? row[vk] : "" }));
}

function formatKpi(value: unknown): string {
  if (typeof value === "number") {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
  return String(value ?? "—");
}

/** Numeric columns to stack when the spec does not name them explicitly. */
function stackedSeries(
  rows: Record<string, unknown>[],
  x: string,
  requested?: string[],
): string[] {
  if (requested && requested.length > 0) return requested;
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first).filter(
    (key) =>
      key !== x &&
      typeof first[key] !== "boolean" &&
      first[key] !== null &&
      Number.isFinite(Number(first[key])),
  );
}

function tableColumns(rows: Record<string, unknown>[]): string[] {
  const first = rows[0];
  return first ? Object.keys(first) : [];
}

function StackedBar({
  rows,
  x,
  series,
  width,
  height,
}: {
  rows: Record<string, unknown>[];
  x: string;
  series: string[];
  width: number;
  height: number;
}) {
  return (
    <BarChart data={rows} width={width} height={height}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
      <XAxis dataKey={x} stroke={AXIS} fontSize={11} />
      <YAxis stroke={AXIS} fontSize={11} />
      <Tooltip contentStyle={TOOLTIP} />
      <Legend />
      {series.map((key, i) => (
        <Bar
          key={key}
          dataKey={key}
          stackId="a"
          fill={COLORS[i % COLORS.length]}
          radius={i === series.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
        />
      ))}
    </BarChart>
  );
}

/**
 * Simple categorical heatmap (x columns × y rows). Values are colour-scaled
 * against the maximum; the value itself is shown in each cell.
 */
function Heatmap({
  rows,
  x,
  y,
  value,
}: {
  rows: Record<string, unknown>[];
  x: string;
  y: string;
  value: string;
}) {
  const { xs, ys, cell, max } = useMemo(
    () => buildHeatmap(rows, x, y, value),
    [rows, x, y, value],
  );
  if (xs.length === 0 || ys.length === 0) {
    return (
      <Text type="supporting" color="secondary">
        No cells
      </Text>
    );
  }
  return (
    <div
      className="aegis-heatmap"
      style={{ gridTemplateColumns: `auto repeat(${xs.length}, minmax(0, 1fr))` }}
    >
      <div />
      {xs.map((xv) => (
        <div className="aegis-heatmap-x" key={`x-${xv}`}>
          {xv}
        </div>
      ))}
      {ys.map((yv) => (
        <Fragment key={`row-${yv}`}>
          <div className="aegis-heatmap-y">{yv}</div>
          {xs.map((xv) => {
            const v = cell.get(cellKey(yv, xv)) ?? null;
            const t = max > 0 && v !== null ? Math.max(0, Math.min(1, v / max)) : 0;
            return (
              <div
                className="aegis-heatmap-cell"
                key={`${yv}-${xv}`}
                style={{ background: heatColor(t), color: t > 0.55 ? "#fff" : "#18181b" }}
                title={`${yv} · ${xv}: ${v ?? "—"}`}
              >
                {v === null ? "" : formatKpi(v)}
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

function cellKey(y: string, x: string): string {
  return `${y}\u0000${x}`;
}

function buildHeatmap(
  rows: Record<string, unknown>[],
  x: string,
  y: string,
  value: string,
): { xs: string[]; ys: string[]; cell: Map<string, number | null>; max: number } {
  const xs: string[] = [];
  const ys: string[] = [];
  const cell = new Map<string, number | null>();
  let max = 0;
  for (const row of rows) {
    const xv = String(row[x] ?? "");
    const yv = String(row[y] ?? "");
    if (!xs.includes(xv)) xs.push(xv);
    if (!ys.includes(yv)) ys.push(yv);
    const raw = row[value];
    const n = typeof raw === "number" ? raw : Number(raw);
    const v = raw === null || raw === "" || !Number.isFinite(n) ? null : n;
    cell.set(cellKey(yv, xv), v);
    if (v !== null && v > max) max = v;
  }
  return { xs, ys, cell, max };
}

/** Interpolate #eef2ff -> #4f46e5 by intensity `t` (0..1). */
function heatColor(t: number): string {
  const from = [238, 242, 255];
  const to = [79, 70, 229];
  const c = from.map((f, i) => Math.round(f + ((to[i] ?? f) - f) * t));
  return `rgb(${c.join(",")})`;
}

function guessKey(rows: Record<string, unknown>[], index: number): string {
  const first = rows[0];
  if (!first) return "";
  return Object.keys(first)[index] ?? Object.keys(first)[0] ?? "";
}
