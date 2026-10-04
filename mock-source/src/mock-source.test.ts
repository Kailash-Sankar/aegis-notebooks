import { test } from "node:test";
import assert from "node:assert/strict";
import { applySchema, openDb, seed } from "./db.js";
import { startGenerator } from "./generator.js";
import { listen } from "./server.js";

function freshDb(): ReturnType<typeof openDb> {
  const db = openDb(":memory:");
  applySchema(db);
  seed(db);
  return db;
}

function insertEvent(
  db: ReturnType<typeof openDb>,
  eventId: string,
  updatedAt: string,
): void {
  db.prepare(
    "INSERT INTO stream_events " +
      "(event_id, channel_id, started_at, ended_at, peak_viewers, watch_minutes, updated_at) " +
      "VALUES (?, 1, ?, NULL, 10, 20, ?)",
  ).run(eventId, updatedAt, updatedAt);
}

test("walks every row exactly once via cursor pagination", async () => {
  const db = freshDb();
  for (let i = 0; i < 23; i += 1) {
    insertEvent(db, `evt_${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`);
  }
  const { server, url } = await listen(db, {}, 0);
  try {
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const q = new URLSearchParams({ limit: "5" });
      if (cursor) q.set("cursor", cursor);
      const res = await fetch(`${url}/v1/stream_events?${q.toString()}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        data: Array<{ event_id: string }>;
        next_cursor: string | null;
      };
      for (const row of body.data) {
        assert.ok(!seen.has(row.event_id), `duplicate row ${row.event_id}`);
        seen.add(row.event_id);
      }
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    assert.equal(seen.size, 23);
  } finally {
    server.close();
    db.close();
  }
});

test("updated_since filters to newer rows only", async () => {
  const db = freshDb();
  insertEvent(db, "old", "2026-01-01T00:00:00.000Z");
  insertEvent(db, "new", "2026-01-02T00:00:00.000Z");
  const { server, url } = await listen(db, {}, 0);
  try {
    const res = await fetch(
      `${url}/v1/stream_events?updated_since=2026-01-01T12:00:00.000Z`,
    );
    const body = (await res.json()) as { data: Array<{ event_id: string }> };
    assert.deepEqual(
      body.data.map((r) => r.event_id),
      ["new"],
    );
  } finally {
    server.close();
    db.close();
  }
});

test("generator emits a late arrival with a back-dated updated_at", () => {
  const db = freshDb();
  const gen = startGenerator(db, { latePercent: 1, seed: 7 });
  const before = Date.now();
  const result = gen.tick();
  gen.stop();
  assert.equal(result.late, true);
  assert.ok(result.insertedEvent);
  const row = db
    .prepare("SELECT updated_at FROM stream_events WHERE event_id = ?")
    .get(result.insertedEvent);
  assert.ok(row);
  const ageMs = before - Date.parse(String(row.updated_at));
  // Late arrivals are back-dated by at least ~5 minutes.
  assert.ok(ageMs >= 4 * 60_000, `expected back-dated, age=${ageMs}ms`);
  db.close();
});

test("generator adds a column on schema drift", () => {
  const db = freshDb();
  const gen = startGenerator(db, { driftAfterTicks: 1, seed: 1 });
  const result = gen.tick();
  gen.stop();
  assert.equal(result.driftAdded, "streamers.game");
  const cols = db
    .prepare("PRAGMA table_info(streamers)")
    .all()
    .map((c) => String(c.name));
  assert.ok(cols.includes("game"));
  db.close();
});

test("generator ids stay unique across restarts (same seed)", () => {
  const db = freshDb();
  const first = startGenerator(db, { seed: 1 });
  const ids = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const r = first.tick();
    if (r.insertedEvent) ids.add(r.insertedEvent);
  }
  first.stop();
  // A restarted generator with the same seed must not collide with persisted
  // rows (event ids are random, not derived from the seeded RNG).
  const second = startGenerator(db, { seed: 1 });
  for (let i = 0; i < 5; i += 1) {
    const r = second.tick();
    assert.ok(r.insertedEvent);
    ids.add(r.insertedEvent);
  }
  second.stop();
  assert.equal(ids.size, 10);
  db.close();
});
