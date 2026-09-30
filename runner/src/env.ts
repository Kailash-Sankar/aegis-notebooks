import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load `.env` from the runner working directory if present. Uses Node's
 * built-in loader (no dependency). Real environment variables take precedence
 * only if set before this runs; `loadEnvFile` does not override existing ones.
 */
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn(`[env] failed to load ${envPath}:`, err);
  }
}
