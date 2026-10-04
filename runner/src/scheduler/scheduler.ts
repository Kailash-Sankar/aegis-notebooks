import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { telemetry } from "../telemetry/metrics.js";

/**
 * A minimal hand-rolled scheduler (design §4.6/§7): job definitions live in
 * code, `lastRunAt` in `state.json`, and an append-only `runs.jsonl` records
 * every run. An in-process guard prevents overlapping runs of the same job.
 *
 * This is deliberately small — it teaches the primitives (due calculation,
 * leases, run history, retries are the job's concern) before reaching for
 * Dagster/Airflow.
 */
export interface ScheduledJob {
  id: string;
  intervalMs: number;
  description: string;
  run: () => Promise<string | void>;
}

export interface JobStatus {
  id: string;
  intervalMs: number;
  description: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  running: boolean;
}

export interface SchedulerOptions {
  stateDir: string;
  tickMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly lastRun = new Map<string, number>();
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly statePath: string;
  private readonly runsPath: string;

  constructor(private readonly options: SchedulerOptions) {
    this.statePath = join(options.stateDir, "state.json");
    this.runsPath = join(options.stateDir, "runs.jsonl");
  }

  register(job: ScheduledJob): void {
    this.jobs.set(job.id, job);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private async loadState(): Promise<void> {
    if (!existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(
        await readFile(this.statePath, "utf8"),
      ) as Record<string, number>;
      for (const [id, ts] of Object.entries(parsed)) this.lastRun.set(id, ts);
    } catch {
      // corrupt state: start fresh
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const obj: Record<string, number> = {};
    for (const [id, ts] of this.lastRun) obj[id] = ts;
    const tmp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await rename(tmp, this.statePath);
  }

  /** Jobs that are due and not already running. */
  due(now = this.now()): ScheduledJob[] {
    return [...this.jobs.values()].filter((job) => {
      if (this.running.has(job.id)) return false;
      const last = this.lastRun.get(job.id);
      return last === undefined || now - last >= job.intervalMs;
    });
  }

  async runJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job: ${id}`);
    if (this.running.has(id)) return;
    this.running.add(id);
    const startedAt = this.now();
    let status = "ok";
    let detail = "";
    try {
      detail = (await job.run()) ?? "";
    } catch (err) {
      status = "error";
      detail = err instanceof Error ? err.message : String(err);
    } finally {
      this.running.delete(id);
      const finishedAt = this.now();
      this.lastRun.set(id, finishedAt);
      telemetry().recordJob(id, status, finishedAt - startedAt);
      await this.saveState();
      await this.appendRun({
        job: id,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        status,
        detail,
      });
      this.log(`[scheduler] ${id} ${status}${detail ? `: ${detail}` : ""}`);
    }
  }

  private async appendRun(entry: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.runsPath), { recursive: true });
    await appendFile(this.runsPath, JSON.stringify(entry) + "\n", "utf8");
  }

  async start(): Promise<void> {
    await this.loadState();
    const tickMs = this.options.tickMs ?? 30_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    this.timer.unref?.();
    this.log(`[scheduler] started (tick ${tickMs}ms, ${this.jobs.size} jobs)`);
  }

  async tick(): Promise<void> {
    for (const job of this.due()) {
      await this.runJob(job.id);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): JobStatus[] {
    return [...this.jobs.values()].map((job) => {
      const last = this.lastRun.get(job.id);
      return {
        id: job.id,
        intervalMs: job.intervalMs,
        description: job.description,
        lastRunAt: last === undefined ? null : new Date(last).toISOString(),
        nextRunAt:
          last === undefined ? null : new Date(last + job.intervalMs).toISOString(),
        running: this.running.has(job.id),
      };
    });
  }

  async recentRuns(limit = 50): Promise<Array<Record<string, unknown>>> {
    if (!existsSync(this.runsPath)) return [];
    const lines = (await readFile(this.runsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .slice(-limit);
    return lines.map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { malformed: line };
      }
    });
  }
}
