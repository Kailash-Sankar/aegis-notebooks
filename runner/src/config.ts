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
  };
}
