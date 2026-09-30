/**
 * Single-user shim (ADR 0006).
 *
 * The MVP ships no auth. Every call site resolves the acting user through this
 * function. When PocketBase auth is enabled later, only this module changes:
 * it should read a session/token and return the real user. Owner columns
 * already exist in the schema, so no data migration is required.
 */

export interface User {
  id: string;
  name: string;
}

export const LOCAL_USER_ID = "local";

const LOCAL_USER: User = { id: LOCAL_USER_ID, name: "Local User" };

export function currentUser(): User {
  return LOCAL_USER;
}
