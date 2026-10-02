import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "../ids.js";
import type { Report, ReportMeta } from "../types.js";
import { KeyedQueue } from "../util/keyed-queue.js";

/**
 * Full-page static reports (Tier 1). Reports are standalone HTML/SVG documents
 * rendered in a sandboxed frame, distinct from canvas widgets. Disk is the
 * authority (ADR 0002): `reports/index.json` + `reports/<id>.html`.
 *
 * Index writes are serialized so concurrent tool calls can't clobber metadata.
 */
const indexLock = new KeyedQueue();

function indexPath(reportsDir: string): string {
  return join(reportsDir, "index.json");
}

function reportPath(reportsDir: string, reportId: string): string {
  return join(reportsDir, `${reportId}.html`);
}

function isMeta(value: unknown): value is ReportMeta {
  const m = value as Partial<ReportMeta> | null;
  return Boolean(m && typeof m.id === "string" && typeof m.title === "string");
}

/** Newest first. Tolerates a missing or malformed index. */
export async function listReports(reportsDir: string): Promise<ReportMeta[]> {
  const path = indexPath(reportsDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isMeta)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export async function readReport(
  reportsDir: string,
  reportId: string,
): Promise<Report | null> {
  const meta = (await listReports(reportsDir)).find((r) => r.id === reportId);
  if (!meta || !existsSync(reportPath(reportsDir, reportId))) return null;
  const html = await readFile(reportPath(reportsDir, reportId), "utf8");
  return { ...meta, html };
}

export interface WriteReportInput {
  /** Existing id to replace; omit (or unknown id) to create a new report. */
  id?: string;
  notebookId: string;
  title: string;
  html: string;
}

/** Create or replace a report. Returns its metadata. */
export async function writeReport(
  reportsDir: string,
  input: WriteReportInput,
): Promise<ReportMeta> {
  return indexLock.run(reportsDir, async () => {
    await mkdir(reportsDir, { recursive: true });
    const list = await listReports(reportsDir);
    const existing = input.id
      ? list.find((r) => r.id === input.id)
      : undefined;
    const id = existing?.id ?? input.id ?? newId();
    const now = new Date().toISOString();
    const meta: ReportMeta = {
      id,
      notebookId: input.notebookId,
      title: input.title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Atomic writes: a crash mid-write can't corrupt the body or the index.
    const tmpHtml = `${reportPath(reportsDir, id)}.tmp`;
    await writeFile(tmpHtml, input.html, "utf8");
    await rename(tmpHtml, reportPath(reportsDir, id));

    const others = list.filter((r) => r.id !== id);
    const next = [meta, ...others];
    const tmpIndex = `${indexPath(reportsDir)}.tmp`;
    await writeFile(tmpIndex, JSON.stringify(next, null, 2), "utf8");
    await rename(tmpIndex, indexPath(reportsDir));
    return meta;
  });
}

export async function deleteReport(
  reportsDir: string,
  reportId: string,
): Promise<boolean> {
  return indexLock.run(reportsDir, async () => {
    const list = await listReports(reportsDir);
    if (!list.some((r) => r.id === reportId)) return false;
    await rm(reportPath(reportsDir, reportId), { force: true });
    const next = list.filter((r) => r.id !== reportId);
    const tmpIndex = `${indexPath(reportsDir)}.tmp`;
    await writeFile(tmpIndex, JSON.stringify(next, null, 2), "utf8");
    await rename(tmpIndex, indexPath(reportsDir));
    return true;
  });
}
