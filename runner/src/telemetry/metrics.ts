import {
  metrics as apiMetrics,
  type Counter,
  type Histogram,
  type Meter,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { Config } from "../config.js";

/**
 * Metrics are the backbone of observability (design §6): a handful of counters,
 * histograms and gauges that answer "is the pipeline working, and how fresh is
 * the data?" — exported over OTLP to the collector. Traces/logs are bounded
 * elsewhere (tail sampling, errors-only logs).
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset this is a no-op, so the pipeline
 * runs unchanged without a collector.
 */
export interface Telemetry {
  readonly enabled: boolean;
  /** One landed chunk: rows written, and whether it was a dedupe no-op. */
  recordChunk(rows: number, deduped: boolean): void;
  recordJob(job: string, status: string, durationMs: number): void;
  recordHttp(method: string, path: string, status: number, durationMs: number): void;
  /** Seconds since the newest event in a workspace's silver table. */
  setFreshness(workspaceId: string, seconds: number): void;
  /** Queue counters; `pending` = published - consumed (a local lag proxy). */
  incQueuePublished(count?: number): void;
  incQueueConsumed(count?: number): void;
  shutdown(): Promise<void>;
}

const NOOP: Telemetry = {
  enabled: false,
  recordChunk() {},
  recordJob() {},
  recordHttp() {},
  setFreshness() {},
  incQueuePublished() {},
  incQueueConsumed() {},
  async shutdown() {},
};

class OtelTelemetry implements Telemetry {
  readonly enabled = true;
  private readonly chunks: Counter;
  private readonly rows: Counter;
  private readonly deduped: Counter;
  private readonly jobRuns: Counter;
  private readonly jobDuration: Histogram;
  private readonly httpRequests: Counter;
  private readonly httpDuration: Histogram;
  private readonly freshness = new Map<string, number>();
  private published = 0;
  private consumed = 0;

  constructor(
    meter: Meter,
    private readonly provider: MeterProvider,
  ) {
    this.chunks = meter.createCounter("aegis.ingest.chunks", {
      description: "Chunks landed into the raw lake",
    });
    this.rows = meter.createCounter("aegis.ingest.rows", {
      description: "Rows landed into the raw lake",
    });
    this.deduped = meter.createCounter("aegis.ingest.dedupe", {
      description: "Chunks whose bytes were already present (dedupe)",
    });
    this.jobRuns = meter.createCounter("aegis.jobs.runs", {
      description: "Scheduled job executions",
    });
    this.jobDuration = meter.createHistogram("aegis.jobs.duration", {
      description: "Scheduled job duration",
      unit: "ms",
    });
    this.httpRequests = meter.createCounter("aegis.http.requests", {
      description: "HTTP requests handled by the runner",
    });
    this.httpDuration = meter.createHistogram("aegis.http.duration", {
      description: "HTTP request duration",
      unit: "ms",
    });

    meter
      .createObservableGauge("aegis.freshness.seconds", {
        description: "Seconds since the newest silver event, per workspace",
        unit: "s",
      })
      .addCallback((result) => {
        for (const [workspace, seconds] of this.freshness) {
          result.observe(seconds, { workspace });
        }
      });

    meter
      .createObservableGauge("aegis.queue.pending", {
        description: "Published-minus-consumed chunks (local lag proxy)",
      })
      .addCallback((result) => {
        result.observe(Math.max(0, this.published - this.consumed));
      });
  }

  recordChunk(rows: number, isDeduped: boolean): void {
    this.chunks.add(1);
    this.rows.add(rows);
    if (isDeduped) this.deduped.add(1);
  }

  recordJob(job: string, status: string, durationMs: number): void {
    // `scheduled_job`, not `job`: the Prometheus exporter derives a constant
    // `job` label from service.name, and a duplicate label is rejected.
    this.jobRuns.add(1, { scheduled_job: job, status });
    this.jobDuration.record(durationMs, { scheduled_job: job });
  }

  recordHttp(method: string, path: string, status: number, durationMs: number): void {
    this.httpRequests.add(1, { method, path, status });
    this.httpDuration.record(durationMs, { method, path });
  }

  setFreshness(workspaceId: string, seconds: number): void {
    this.freshness.set(workspaceId, seconds);
  }

  incQueuePublished(count = 1): void {
    this.published += count;
  }

  incQueueConsumed(count = 1): void {
    this.consumed += count;
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}

let current: Telemetry = NOOP;

/** Initialise telemetry once at startup. No-op when OTLP is not configured. */
export function initTelemetry(config: Config): Telemetry {
  if (!config.otelEnabled || !config.OTEL_EXPORTER_OTLP_ENDPOINT) return current;
  const exporter = new OTLPMetricExporter({
    url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/metrics`,
  });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 10_000,
  });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME,
    }),
    readers: [reader],
  });
  apiMetrics.setGlobalMeterProvider(provider);
  current = new OtelTelemetry(provider.getMeter("aegis"), provider);
  return current;
}

export function telemetry(): Telemetry {
  return current;
}
