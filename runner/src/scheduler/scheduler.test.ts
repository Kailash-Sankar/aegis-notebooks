import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "./scheduler.js";

test("due() respects interval and run history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aegis-sched-"));
  try {
    let t = 1_000_000;
    const scheduler = new Scheduler({ stateDir: dir, now: () => t });
    scheduler.register({
      id: "a",
      intervalMs: 100,
      description: "test job",
      run: async () => "ok",
    });

    assert.equal(scheduler.due().length, 1); // never run -> due
    await scheduler.runJob("a");
    assert.equal(scheduler.due().length, 0); // just ran -> not due
    t += 100;
    assert.equal(scheduler.due().length, 1); // interval elapsed

    const runs = await scheduler.recentRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.job, "a");
    assert.equal(runs[0]?.status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runJob guards against overlap and records errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aegis-sched-"));
  try {
    const scheduler = new Scheduler({ stateDir: dir });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scheduler.register({
      id: "slow",
      intervalMs: 1,
      description: "slow job",
      run: async () => {
        await gate;
        return "done";
      },
    });

    const first = scheduler.runJob("slow");
    await scheduler.runJob("slow"); // already running -> returns immediately
    assert.equal(scheduler.list()[0]?.running, true);
    release();
    await first;
    assert.equal(scheduler.list()[0]?.running, false);

    scheduler.register({
      id: "bad",
      intervalMs: 1,
      description: "failing job",
      run: async () => {
        throw new Error("boom");
      },
    });
    await scheduler.runJob("bad");
    const runs = await scheduler.recentRuns();
    const bad = runs.find((r) => r.job === "bad");
    assert.equal(bad?.status, "error");
    assert.match(String(bad?.detail), /boom/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
