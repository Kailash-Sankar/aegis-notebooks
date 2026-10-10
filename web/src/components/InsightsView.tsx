import { useEffect, useState } from "react";
import { getHydration, listInsights } from "../api.js";
import type { HydrationManifest, Insight } from "../types.js";

/**
 * Surfaces the warehouse in the notebook: background-computed `aggregated_insights`
 * and the local hydration window (`hydrate_<table>` DuckDB views).
 */
export function InsightsView({
  workspaceId,
  refreshToken,
}: {
  workspaceId: string;
  refreshToken: number;
}) {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [hydration, setHydration] = useState<HydrationManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([listInsights(workspaceId), getHydration(workspaceId)])
      .then(([rows, manifest]) => {
        if (cancelled) return;
        setInsights(rows);
        setHydration(manifest);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken]);

  const asOf = insights?.[0]?.as_of ?? hydration?.asOf ?? null;

  return (
    <div className="aegis-insights">
      <div className="aegis-insights-header">
        <span className="aegis-insights-title">Insights</span>
        {asOf && <span className="aegis-muted">data as of {asOf}</span>}
      </div>

      {error && <p className="aegis-error">{error}</p>}

      {insights === null && !error && <p className="aegis-muted">Loading…</p>}

      {insights && insights.length === 0 && (
        <p className="aegis-muted">
          No insights yet. Ingest data and run the insights job (the scheduler
          runs it periodically).
        </p>
      )}

      {insights && insights.length > 0 && (
        <div className="aegis-insight-grid">
          {insights.map((insight, i) => (
            <div key={`${insight.kind}-${insight.channel_id}-${i}`} className="aegis-insight-card">
              <div className="aegis-insight-kind">{insight.kind}</div>
              <div className="aegis-insight-headline">{insight.headline}</div>
              <div className="aegis-insight-value">
                {typeof insight.value === "number"
                  ? insight.value.toLocaleString()
                  : String(insight.value)}
                <span className="aegis-muted"> {insight.metric}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="aegis-insights-header">
        <span className="aegis-insights-title">Warehouse window</span>
        {hydration && (
          <span className="aegis-muted">last {hydration.window.days} days</span>
        )}
      </div>

      {hydration ? (
        <table className="aegis-warehouse-table">
          <thead>
            <tr>
              <th>DuckDB view</th>
              <th>partitions</th>
              <th>refreshed</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(hydration.tables).map(([table, hydrated]) => (
              <tr key={table}>
                <td><code>{hydrated.view}</code></td>
                <td>{Object.keys(hydrated.partitions).length}</td>
                <td className="aegis-muted">{hydrated.watermark}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="aegis-muted">
          Warehouse not hydrated yet. Pull a source, then refresh the hydration
          window (the scheduler does this periodically).
        </p>
      )}
    </div>
  );
}
