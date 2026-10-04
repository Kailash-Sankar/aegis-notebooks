import { resolve } from "node:path";
import { z } from "zod";

/**
 * All runner configuration comes from the environment (ADR 0005: caps are
 * config, not constants). See .env.example.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().default(8787),
  WORKSPACES_ROOT: z.string().default("../workspaces"),

  // Model / Pi
  // NOTE: intentionally NOT named PI_MODEL/PI_THINKING -- the Pi agent that
  // runs the runner (or a Pi-based shell) injects PI_* variables, which would
  // otherwise leak into and override the runner's model selection.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  AEGIS_MODEL: z.string().optional(),
  AEGIS_THINKING: z.enum(["off", "low", "medium", "high"]).default("medium"),

  // PocketBase registry (ADR 0002)
  POCKETBASE_URL: z.string().default("http://127.0.0.1:8090"),
  POCKETBASE_ADMIN_EMAIL: z.string().optional(),
  POCKETBASE_ADMIN_PASSWORD: z.string().optional(),

  // RustFS recovery set (ADR 0001). When unset, backups are skipped.
  RUSTFS_ENDPOINT: z.string().optional(),
  RUSTFS_REGION: z.string().default("us-east-1"),
  RUSTFS_ACCESS_KEY: z.string().optional(),
  RUSTFS_SECRET_KEY: z.string().optional(),
  RUSTFS_BUCKET: z.string().default("aegis-backups"),
  // Raw lake authority (ADR 0007). Separate bucket, same RustFS instance.
  RUSTFS_RAW_BUCKET: z.string().default("aegis-raw"),

  // Broker (Redpanda / Kafka API). Unset => in-process MemoryBroker (dev/test).
  KAFKA_BROKERS: z.string().optional(),
  KAFKA_CLIENT_ID: z.string().default("aegis-runner"),

  // ClickHouse warehouse (Phase 2+).
  CLICKHOUSE_URL: z.string().optional(),
  CLICKHOUSE_DB: z.string().default("aegis"),
  CLICKHOUSE_USER: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),

  // Inngest (control plane). Unset => the chunk bridge loads inline (dev/test).
  INNGEST_BASE_URL: z.string().optional(),
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  // Hand-rolled scheduler (Phase 3/5). Definitions live in code; run history is
  // an append-only log under the scheduler state dir (<workspaces>/.scheduler).
  SCHEDULER_ENABLED: z.string().default("1"),
  SCHEDULER_TICK_MS: z.coerce.number().default(30_000),
  SCHEDULER_REFRESH_INTERVAL_MS: z.coerce.number().default(3_600_000),
  SCHEDULER_INSIGHTS_INTERVAL_MS: z.coerce.number().default(900_000),

  // Quotas (ADR 0005)
  QUOTA_TOTAL_BYTES: z.coerce.number().default(10 * 1024 ** 3),
  QUOTA_FILE_BYTES: z.coerce.number().default(1024 ** 3),
  QUOTA_FILE_COUNT: z.coerce.number().default(500),
  QUOTA_WIDGET_ROWS: z.coerce.number().default(100_000),

  // DuckDB
  DUCKDB_CLI: z.string().default("duckdb"),
});

export type Config = z.infer<typeof EnvSchema> & {
  /** Absolute path to the local working set. */
  workspacesRootAbs: string;
  /** True when both RustFS credentials/endpoint are present. */
  backupsEnabled: boolean;
  /** True when PocketBase admin credentials are present. */
  registryEnabled: boolean;
  /** True when a Kafka/Redpanda broker is configured. */
  brokerEnabled: boolean;
  /** True when a ClickHouse URL is configured. */
  clickhouseEnabled: boolean;
  /** True when Inngest is configured to receive events. */
  inngestEnabled: boolean;
  /** True when the periodic scheduler should run. */
  schedulerEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  return {
    ...parsed,
    workspacesRootAbs: resolve(process.cwd(), parsed.WORKSPACES_ROOT),
    backupsEnabled: Boolean(
      parsed.RUSTFS_ENDPOINT && parsed.RUSTFS_ACCESS_KEY && parsed.RUSTFS_SECRET_KEY,
    ),
    registryEnabled: Boolean(
      parsed.POCKETBASE_ADMIN_EMAIL && parsed.POCKETBASE_ADMIN_PASSWORD,
    ),
    brokerEnabled: Boolean(parsed.KAFKA_BROKERS && parsed.KAFKA_BROKERS.trim()),
    clickhouseEnabled: Boolean(parsed.CLICKHOUSE_URL),
    inngestEnabled: Boolean(parsed.INNGEST_BASE_URL || parsed.INNGEST_EVENT_KEY),
    schedulerEnabled: !["0", "false", "no"].includes(parsed.SCHEDULER_ENABLED.toLowerCase()),
  };
}
