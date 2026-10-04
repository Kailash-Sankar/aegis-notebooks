import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";

interface DatasetConfig {
  table: string;
  pk: string;
}

/** The datasets this mock source exposes. */
export const DATASETS: Record<string, DatasetConfig> = {
  streamers: { table: "streamers", pk: "channel_id" },
  stream_events: { table: "stream_events", pk: "event_id" },
};

export interface ServerOptions {
  /** Probability a `/v1/*` request fails with a `429` or `500` (0 = never). */
  faultRate?: number;
  defaultLimit?: number;
  maxLimit?: number;
}

interface Cursor {
  /** updated_at of the last row on the previous page. */
  c: string;
  /** primary key of the last row on the previous page. */
  p: string | number;
}

function encodeCursor(updatedAt: string, pk: string | number): string {
  return Buffer.from(JSON.stringify({ c: updatedAt, p: pk })).toString("base64url");
}

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<Cursor>;
    if (
      typeof parsed.c === "string" &&
      (typeof parsed.p === "string" || typeof parsed.p === "number")
    ) {
      return { c: parsed.c, p: parsed.p };
    }
  } catch {
    // fall through to null
  }
  return null;
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Build (but do not start) the mock HTTP API over a source DB. */
export function createMockServer(
  db: DatabaseSync,
  options: ServerOptions = {},
): Server {
  const faultRate = options.faultRate ?? 0;
  const defaultLimit = options.defaultLimit ?? 200;
  const maxLimit = options.maxLimit ?? 1000;

  function maybeFault(res: import("node:http").ServerResponse): boolean {
    if (faultRate <= 0 || Math.random() >= faultRate) return false;
    if (Math.random() < 0.5) {
      sendJson(res, 429, { error: "rate_limited" }, { "retry-after": "1" });
    } else {
      sendJson(res, 500, { error: "internal" });
    }
    return true;
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    const dataset = url.pathname.replace(/^\/v1\//, "");
    const cfg = DATASETS[dataset];
    if (!url.pathname.startsWith("/v1/") || !cfg) {
      sendJson(res, 404, { error: "not_found", path: url.pathname });
      return;
    }

    if (maybeFault(res)) return;

    const since = url.searchParams.get("updated_since");
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), maxLimit)
      : defaultLimit;

    let sql = `SELECT * FROM ${cfg.table} WHERE 1 = 1`;
    const params: Array<string | number> = [];
    if (since) {
      sql += " AND updated_at > ?";
      params.push(since);
    }
    if (cursor) {
      sql += ` AND (updated_at > ? OR (updated_at = ? AND ${cfg.pk} > ?))`;
      params.push(cursor.c, cursor.c, cursor.p);
    }
    sql += ` ORDER BY updated_at, ${cfg.pk} LIMIT ?`;
    params.push(limit + 1);

    const rows = db.prepare(sql).all(...params);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const next_cursor =
      hasMore && last
        ? encodeCursor(String(last.updated_at), last[cfg.pk] as string | number)
        : null;

    sendJson(res, 200, {
      data: page,
      next_cursor,
      server_time: new Date().toISOString(),
    });
  });
}

/** Start the mock server on `port` (0 = ephemeral) and resolve its address. */
export function listen(
  db: DatabaseSync,
  options: ServerOptions = {},
  port = 0,
  host = "127.0.0.1",
): Promise<{ server: Server; url: string; port: number }> {
  const server = createMockServer(db, options);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr !== null ? addr.port : port;
      resolve({
        server,
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
      });
    });
  });
}
