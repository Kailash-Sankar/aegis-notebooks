import type { SourceContract } from "./contract.js";
import type { ConnectorState } from "./state.js";

/**
 * The connector pulls chunks from a source HTTP API. It is deliberately dumb
 * about meaning: it pages, tracks the watermark, and retries transient
 * failures. Shaping happens later, in the loader, against the contract.
 *
 * See design §4.1/§4.3.
 */

export interface SourcePage {
  data: Array<Record<string, unknown>>;
  nextCursor: string | null;
  serverTime?: string;
}

export interface FetchPageArgs {
  endpoint: string;
  /** Watermark lower bound; set only on the first page of a run. */
  updatedSince?: string;
  cursor?: string | null;
  limit: number;
}

export interface SourceClient {
  fetchPage(args: FetchPageArgs): Promise<SourcePage>;
}

/** A classified source error: whether to retry, and how long to wait. */
export class HttpSourceError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    opts: { status?: number; retryable: boolean; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "HttpSourceError";
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** HTTP implementation of `SourceClient` against a source base URL. */
export class HttpSourceClient implements SourceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async fetchPage(args: FetchPageArgs): Promise<SourcePage> {
    const url = new URL(args.endpoint, this.baseUrl);
    if (args.updatedSince) url.searchParams.set("updated_since", args.updatedSince);
    if (args.cursor) url.searchParams.set("cursor", args.cursor);
    url.searchParams.set("limit", String(args.limit));

    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    } catch (err) {
      // Network/timeout: transient.
      throw new HttpSourceError(
        `source request failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true },
      );
    }

    if (!res.ok) {
      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
      const retryable = res.status === 429 || res.status >= 500;
      throw new HttpSourceError(`source GET ${url.pathname} -> ${res.status}`, {
        status: res.status,
        retryable,
        ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
          ? { retryAfterMs }
          : {}),
      });
    }

    const body = (await res.json()) as {
      data?: unknown;
      next_cursor?: unknown;
      nextCursor?: unknown;
      server_time?: unknown;
      serverTime?: unknown;
    };
    const nextCursor = body.next_cursor ?? body.nextCursor;
    const serverTime = body.server_time ?? body.serverTime;
    return {
      data: Array.isArray(body.data)
        ? (body.data as Array<Record<string, unknown>>)
        : [],
      nextCursor: typeof nextCursor === "string" ? nextCursor : null,
      ...(typeof serverTime === "string" ? { serverTime } : {}),
    };
  }
}

/** One page of raw rows plus the watermark range it covers. */
export interface RawChunk {
  rows: Array<Record<string, unknown>>;
  /** Cursor to resume after this chunk (null when exhausted). */
  cursor: string | null;
  sync: { mode: string; from?: string; to?: string };
  fetchedAt: string;
}

export interface PullArgs {
  client: SourceClient;
  contract: SourceContract;
  state?: ConnectorState | null;
  /** Stop after this many chunks (safety bound). */
  maxChunks?: number;
  onChunk: (chunk: RawChunk) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  onRetry?: (info: { attempt: number; delayMs: number; status?: number }) => void;
}

export interface PullResult {
  state: ConnectorState;
  chunks: number;
  rows: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function maxWatermark(
  rows: Array<Record<string, unknown>>,
  field: string | undefined,
  current: string | null,
): string | null {
  if (!field) return current;
  let max = current;
  for (const row of rows) {
    const value = row[field];
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (max === null || text > max) max = text;
  }
  return max;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries: number;
    sleep: (ms: number) => Promise<void>;
    onRetry?: PullArgs["onRetry"];
  },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof HttpSourceError && err.retryable;
      if (!retryable || attempt >= opts.maxRetries) throw err;
      const backoff = Math.min(500 * 2 ** attempt, 15_000);
      const delayMs = (err as HttpSourceError).retryAfterMs ?? backoff;
      attempt += 1;
      opts.onRetry?.({
        attempt,
        delayMs,
        ...((err as HttpSourceError).status !== undefined
          ? { status: (err as HttpSourceError).status }
          : {}),
      });
      await opts.sleep(delayMs);
    }
  }
}

/**
 * Pull every chunk currently available for a contract, invoking `onChunk` per
 * page. The first page constrains by `updatedSince` (the watermark); later pages
 * advance by cursor only, so the cursor tie-break is not defeated by the
 * watermark filter.
 */
export async function pullSource(args: PullArgs): Promise<PullResult> {
  const { client, contract } = args;
  const sleep = args.sleep ?? defaultSleep;
  const maxRetries = args.maxRetries ?? 4;
  const cursorField = contract.sync.cursorField;

  let cursor: string | null = args.state?.cursor ?? null;
  let watermark: string | null = args.state?.watermark ?? null;
  const startWatermark = watermark;

  let chunks = 0;
  let rows = 0;

  for (;;) {
    const page = await withRetry(
      () =>
        client.fetchPage({
          endpoint: contract.sync.endpoint,
          // Only the first page bounds by watermark; cursor advances after.
          ...(cursor === null && watermark !== null
            ? { updatedSince: watermark }
            : {}),
          cursor,
          limit: contract.sync.pageSize,
        }),
      { maxRetries, sleep, ...(args.onRetry ? { onRetry: args.onRetry } : {}) },
    );

    if (page.data.length === 0) break;

    watermark = maxWatermark(page.data, cursorField, watermark);
    const chunk: RawChunk = {
      rows: page.data,
      cursor: page.nextCursor,
      sync: {
        mode: contract.sync.mode,
        ...(startWatermark !== null ? { from: startWatermark } : {}),
        ...(watermark !== null ? { to: watermark } : {}),
      },
      fetchedAt: page.serverTime ?? new Date().toISOString(),
    };

    await args.onChunk(chunk);
    chunks += 1;
    rows += page.data.length;

    if (!page.nextCursor) {
      cursor = null;
      break;
    }
    cursor = page.nextCursor;
    if (args.maxChunks !== undefined && chunks >= args.maxChunks) break;
  }

  return {
    state: {
      cursor: null,
      watermark,
      updatedAt: new Date().toISOString(),
    },
    chunks,
    rows,
  };
}
