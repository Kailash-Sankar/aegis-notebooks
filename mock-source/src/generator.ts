import type { DatabaseSync } from "node:sqlite";

export interface GeneratorOptions {
  /** Tick interval in ms. */
  intervalMs?: number;
  /** Probability a generated event is a late arrival (back-dated `updated_at`). */
  latePercent?: number;
  /** Add `streamers.game` after this many ticks (0 = never); simulates drift. */
  driftAfterTicks?: number;
  /** RNG seed for reproducible runs. */
  seed?: number;
}

export interface TickResult {
  insertedEvent: string | null;
  updatedStreamer: number | null;
  late: boolean;
  driftAdded: string | null;
}

export interface GeneratorHandle {
  /** Run one mutation immediately (used by tests). */
  tick(): TickResult;
  stop(): void;
}

/** Small deterministic PRNG so runs/seeds are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MINUTE = 60_000;

/**
 * A generator that mutates the OLTP source over time. It models the messy
 * reality a connector must survive:
 * - new fact rows,
 * - point updates to a current-state row,
 * - **late arrivals** (rows whose `updated_at` is older than what was already
 *   pulled), and
 * - optional **schema drift** (a new column).
 */
export function startGenerator(
  db: DatabaseSync,
  options: GeneratorOptions = {},
): GeneratorHandle {
  const intervalMs = options.intervalMs ?? 1500;
  const latePercent = options.latePercent ?? 0.15;
  const driftAfterTicks = options.driftAfterTicks ?? 0;
  const rnd = mulberry32(options.seed ?? 42);

  let ticks = 0;
  let drifted = false;

  const channels = (): number[] =>
    db
      .prepare("SELECT channel_id FROM streamers")
      .all()
      .map((r) => Number(r.channel_id));

  function addDriftIfDue(): string | null {
    if (drifted || driftAfterTicks <= 0 || ticks < driftAfterTicks) return null;
    const cols = db
      .prepare("PRAGMA table_info(streamers)")
      .all()
      .map((c) => String(c.name));
    if (!cols.includes("game")) {
      db.exec("ALTER TABLE streamers ADD COLUMN game TEXT");
      // Backfill a few values so the new column is not all-null.
      db.exec(
        "UPDATE streamers SET game = 'Just Chatting' WHERE channel_id % 3 = 0",
      );
    }
    drifted = true;
    return "streamers.game";
  }

  function tick(): TickResult {
    ticks += 1;
    const driftAdded = addDriftIfDue();

    const ids = channels();
    if (ids.length === 0) {
      return { insertedEvent: null, updatedStreamer: null, late: false, driftAdded };
    }
    const pick = ids[Math.floor(rnd() * ids.length)];
    if (pick === undefined) {
      return { insertedEvent: null, updatedStreamer: null, late: false, driftAdded };
    }

    const nowMs = Date.now();
    const late = rnd() < latePercent;

    // Facts: append a stream event. A late arrival carries an `updated_at`
    // older than "now", i.e. it appears after later rows were already pulled.
    const startedMs = nowMs - Math.floor(rnd() * 60 * MINUTE);
    const updatedMs = late
      ? nowMs - Math.floor((5 + rnd() * 115) * MINUTE)
      : nowMs;
    const endedMs = rnd() < 0.7 ? startedMs + Math.floor(rnd() * 60 * MINUTE) : null;
    const eventId = `evt_${ticks}_${Math.floor(rnd() * 1e9).toString(36)}`;

    db.prepare(
      "INSERT INTO stream_events " +
        "(event_id, channel_id, started_at, ended_at, peak_viewers, watch_minutes, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      eventId,
      pick,
      new Date(startedMs).toISOString(),
      endedMs === null ? null : new Date(endedMs).toISOString(),
      Math.floor(rnd() * 500_000),
      Math.floor(rnd() * 5_000_000),
      new Date(updatedMs).toISOString(),
    );

    // Dimensions: point-update followers (current state, always "now").
    db.prepare(
      "UPDATE streamers SET followers = COALESCE(followers, 0) + ?, updated_at = ? " +
        "WHERE channel_id = ?",
    ).run(Math.floor(rnd() * 500), new Date(nowMs).toISOString(), pick);

    return {
      insertedEvent: eventId,
      updatedStreamer: pick,
      late,
      driftAdded,
    };
  }

  const timer = setInterval(tick, intervalMs);
  // Do not keep the process alive solely for the generator.
  if (typeof timer.unref === "function") timer.unref();

  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}
