import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretResolver } from "./auth.js";

/**
 * Per-source credentials. A gitignored `sources/{source}/credentials.json` maps
 * reference names (the `secretRef`s in the contract) to secret values. The
 * environment takes precedence, so production can inject secrets without a file.
 */

export type Credentials = Record<string, string>;

/** Read credentials, tolerating a missing or malformed file. */
export async function readCredentials(path: string): Promise<Credentials> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Credentials = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v !== "") out[k] = v;
      }
      return out;
    }
  } catch {
    // Treat an unreadable file as "no credentials"; the resolver will report
    // the missing reference when auth is actually required.
  }
  return {};
}

/** Atomically write credentials with owner-only (0600) permissions. */
export async function writeCredentials(
  path: string,
  credentials: Credentials,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(credentials, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

/** Environment wins over the credentials file. */
export function makeSecretResolver(
  credentials: Credentials,
  env: NodeJS.ProcessEnv = process.env,
): SecretResolver {
  return (ref) => {
    const fromEnv = env[ref];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    return credentials[ref];
  };
}
