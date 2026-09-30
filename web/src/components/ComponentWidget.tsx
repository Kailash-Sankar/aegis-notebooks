import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
}: {
  workspaceId: string;
  widget: Widget;
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
  const x = chart.x ?? guessKey(rows, 0);
  const y = chart.y ?? guessKey(rows, 1);
  const y2 = chart.y2;

  // DuckDB returns BIGINT/DECIMAL aggregates as strings; Recharts needs numbers.
  const data = useMemo(() => normalizeRows(rows, [y, y2]), [rows, y, y2]);
  // If the charted column isn't numeric, a table is more useful than a blank chart.
  const isNumeric = useMemo(
    () => data.some((row) => typeof row[y] === "number"),
    [data, y],
  );
  const { ref: chartRef, width } = useMeasuredWidth<HTMLDivElement>();

  return (
    <Card padding={0} width="100%">
      <Stack
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
      <Stack padding={3} gap={2}>
        {error && <div className="aegis-error">{error}</div>}
        {!error && data.length === 0 && !loading && (
          <Text type="supporting" color="secondary">
            No rows
          </Text>
        )}
        {!error && data.length > 0 && isNumeric && (
          <div ref={chartRef} style={{ height: 260, width: "100%" }}>
            {width > 0 && (
              <Chart
                type={chart.type ?? "bar"}
                rows={data}
                x={x}
                y={y}
                y2={y2}
                width={width}
                height={260}
              />
            )}
          </div>
        )}
        {!error && data.length > 0 && !isNumeric && (
          <DataTable rows={data} columns={[x, y, y2]} />
        )}
      </Stack>
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
function useMeasuredWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    observer.current = new ResizeObserver(update);
    observer.current.observe(node);
  }, []);
  return { ref, width };
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
    <div style={{ maxHeight: 260, overflow: "auto" }}>
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

function guessKey(rows: Record<string, unknown>[], index: number): string {
  const first = rows[0];
  if (!first) return "";
  return Object.keys(first)[index] ?? Object.keys(first)[0] ?? "";
}
