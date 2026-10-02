import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The mocked OLTP source schema. Kept intentionally simple: a mutable
 * "current state" dimension (`streamers`) and an append-ish fact
 * (`stream_events`). Both carry `updated_at`, the incremental watermark the
 * connector pulls on.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS streamers (
  channel_id   INTEGER PRIMARY KEY,
  display_name TEXT    NOT NULL,
  language     TEXT,
  followers    INTEGER,
  partner      INTEGER,
  mature       INTEGER,
  created_at   TEXT,
  updated_at   TEXT    NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS stream_events (
  event_id      TEXT    PRIMARY KEY,
  channel_id    INTEGER NOT NULL,
  started_at    TEXT    NOT NULL,
  ended_at      TEXT,
  peak_viewers  INTEGER,
  watch_minutes INTEGER,
  updated_at    TEXT    NOT NULL
) STRICT;
`;

/** Open the source DB, creating the parent directory for file-backed DBs. */
export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}

export interface StreamerSeed {
  channelId: number;
  displayName: string;
  language: string;
  followers: number;
  partner: 0 | 1;
  mature: 0 | 1;
}

export const SEED_STREAMERS: StreamerSeed[] = [
  { channelId: 1, displayName: "xQcOW", language: "English", followers: 3_250_000, partner: 1, mature: 1 },
  { channelId: 2, displayName: "summit1g", language: "English", followers: 5_312_000, partner: 1, mature: 0 },
  { channelId: 3, displayName: "Gaules", language: "Portuguese", followers: 1_770_000, partner: 1, mature: 0 },
  { channelId: 4, displayName: "ESL_CSGO", language: "English", followers: 3_940_000, partner: 1, mature: 0 },
  { channelId: 5, displayName: "Tfue", language: "English", followers: 8_940_000, partner: 1, mature: 1 },
  { channelId: 6, displayName: "Asmongold", language: "English", followers: 1_560_000, partner: 1, mature: 0 },
  { channelId: 7, displayName: "NICKMERCS", language: "English", followers: 4_070_000, partner: 1, mature: 0 },
  { channelId: 8, displayName: "Fextralife", language: "English", followers: 512_000, partner: 1, mature: 0 },
  { channelId: 9, displayName: "loltyler1", language: "English", followers: 3_530_000, partner: 1, mature: 1 },
  { channelId: 10, displayName: "Anomaly", language: "English", followers: 2_610_000, partner: 1, mature: 0 },
  { channelId: 11, displayName: "Rubius", language: "Spanish", followers: 12_100_000, partner: 1, mature: 0 },
  { channelId: 12, displayName: "auronplay", language: "Spanish", followers: 11_400_000, partner: 1, mature: 0 },
];

/** Insert the seed set once; no-op if any streamers already exist. */
export function seed(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM streamers").get();
  if (Number(row?.n ?? 0) > 0) return;
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO streamers " +
      "(channel_id, display_name, language, followers, partner, mature, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const s of SEED_STREAMERS) {
    insert.run(
      s.channelId,
      s.displayName,
      s.language,
      s.followers,
      s.partner,
      s.mature,
      now,
      now,
    );
  }
}
