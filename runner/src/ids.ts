import { randomBytes } from "node:crypto";

/**
 * PocketBase record ids are 15-char strings from [a-z0-9]. The runner uses its
 * domain id as the PocketBase record id (upsert-by-id), so ids must be
 * PB-compatible or record creation fails validation.
 */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(length = 15): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}
