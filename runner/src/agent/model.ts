import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";

/**
 * Resolve the model Pi should use.
 *
 * - `AEGIS_MODEL` is `"provider/model-id"`, e.g. `openrouter/anthropic/claude-sonnet-4.5`.
 *   The split is on the FIRST slash, because OpenRouter ids contain slashes.
 * - When unset, the first model with valid credentials is used (Pi's own
 *   default is kept only if nothing is available).
 *
 * Credentials come from the environment (e.g. `OPENROUTER_API_KEY`) or Pi's
 * `auth.json`; ModelRuntime handles that resolution.
 */
export interface ResolvedModel {
  model: Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];
  runtime: ModelRuntime;
}

let runtimePromise: Promise<ModelRuntime> | undefined;

function getRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= ModelRuntime.create();
  return runtimePromise;
}

export async function resolveModel(config: Config): Promise<ResolvedModel | null> {
  const runtime = await getRuntime();
  const spec = config.AEGIS_MODEL?.trim();

  if (spec) {
    const slash = spec.indexOf("/");
    if (slash <= 0 || slash === spec.length - 1) {
      throw new Error(`AEGIS_MODEL must be "provider/model-id" (got "${spec}")`);
    }
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const model = runtime.getModel(provider, id);
    if (!model) {
      const available = await runtime.getAvailable(provider);
      const ids = available.map((m) => m.id).join(", ") || "(none)";
      throw new Error(`Model "${spec}" not found. Available ${provider} models: ${ids}`);
    }
    return { model, runtime };
  }

  const available = await runtime.getAvailable();
  const first = available[0];
  return first ? { model: first, runtime } : null;
}
