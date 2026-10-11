/**
 * Source authentication (design §4.2).
 *
 * The contract declares *how* to present a credential; the secret itself is
 * resolved at pull/discover time — from the process environment (by reference
 * name) or a gitignored per-source `credentials.json`. Secrets never live in the
 * contract, which is disk authority, agent-authored, and summarised into
 * onboarding context.
 */

export type SourceAuth =
  | { type: "none" }
  | { type: "bearer"; secretRef: string }
  | { type: "header"; header: string; secretRef: string }
  | { type: "basic"; usernameRef: string; passwordRef: string }
  | { type: "query"; param: string; secretRef: string };

/** Resolves a secret reference name (env var or credentials file key) to a value. */
export type SecretResolver = (ref: string) => string | undefined;
