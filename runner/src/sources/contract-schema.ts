import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject } from "ajv";

/**
 * The published SourceContract JSON Schema — the "standard" (an OTel-like spec)
 * that makes the contract portable and machine-validated. `parseContract`
 * remains the runtime typed validator; this schema is the interchange format.
 */
export const contractJsonSchema = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "contract.schema.json"),
    "utf8",
  ),
) as object;

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(contractJsonSchema);

export interface SchemaValidation {
  valid: boolean;
  errors: string[];
}

export function validateContractSchema(raw: unknown): SchemaValidation {
  const valid = validate(raw) as boolean;
  return {
    valid,
    errors: (validate.errors ?? []).map(formatError),
  };
}

function formatError(err: ErrorObject): string {
  return `${err.instancePath || "/"} ${err.message ?? "invalid"}`;
}
