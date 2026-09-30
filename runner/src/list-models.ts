import "./env.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * List models that have usable credentials. Run with `npm run models`.
 * Set OPENROUTER_API_KEY (or another provider key) first.
 */
const runtime = await ModelRuntime.create();
const available = await runtime.getAvailable();

if (available.length === 0) {
  console.error("No models available. Set a provider key (e.g. OPENROUTER_API_KEY).");
  process.exit(1);
}

for (const m of available) {
  console.log(`${m.provider}/${m.id}`);
}
