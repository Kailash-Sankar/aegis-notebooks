import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpSourceClient,
  HttpSourceError,
  pullSource,
  type RawChunk,
  type SourceClient,
  type SourcePage,
} from "./connector.js";
import type { SourceContract } from "./contract.js";

const contract: SourceContract = {
  version: 1,
  source: "twitch-mock",
  dataset: "streamers",
  baseUrl: "http://mock.local",
  sync: {
    mode: "incremental",
    endpoint: "/v1/streamers",
    cursorField: "updated_at",
    cursorParam: "updated_since",
    pageSize: 2,
  },
  load: {
    target: "clickhouse",
    layer: "bronze",
    mode: "upsert",
    dedupe: "latest_by_key",
    key: ["channel_id"],
  },
  columns: {
    channel_id: { type: "UInt64" },
    updated_at: { type: "DateTime64(3)", eventTime: true },
  },
};

function page(rows: Array<Record<string, unknown>>, nextCursor: string | null): SourcePage {
  return { data: rows, nextCursor, serverTime: "2026-01-02T00:00:00.000Z" };
}

interface Call {
  cursor: string | null;
  updatedSince?: string;
  limit: number;
}

class FakeClient implements SourceClient {
  readonly calls: Call[] = [];
  constructor(private readonly pages: SourcePage[]) {}
  async fetchPage(args: {
    cursor?: string | null;
    updatedSince?: string;
    limit: number;
  }): Promise<SourcePage> {
    this.calls.push({
      cursor: args.cursor ?? null,
      limit: args.limit,
      ...(args.updatedSince !== undefined ? { updatedSince: args.updatedSince } : {}),
    });
    return this.pages.shift() ?? page([], null);
  }
}

test("pages through chunks and advances the watermark", async () => {
  const client = new FakeClient([
    page(
      [
        { channel_id: 1, updated_at: "2026-01-01T00:00:00.000Z" },
        { channel_id: 2, updated_at: "2026-01-01T01:00:00.000Z" },
      ],
      "c1",
    ),
    page([{ channel_id: 3, updated_at: "2026-01-01T02:00:00.000Z" }], null),
  ]);
  const chunks: RawChunk[] = [];
  const result = await pullSource({
    client,
    contract,
    onChunk: async (chunk) => {
      chunks.push(chunk);
    },
  });

  assert.equal(result.chunks, 2);
  assert.equal(result.rows, 3);
  assert.equal(result.state.watermark, "2026-01-01T02:00:00.000Z");
  assert.equal(result.state.cursor, null);
  assert.equal(chunks[0]?.sync.to, "2026-01-01T01:00:00.000Z");
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0]?.cursor, null);
  assert.equal(client.calls[1]?.cursor, "c1");
  // Continuation pages must not re-apply the watermark filter (it would defeat
  // the cursor tie-break for rows sharing an updated_at).
  assert.equal(client.calls[1]?.updatedSince, undefined);
});

test("resumes from a stored watermark on the first page", async () => {
  const client = new FakeClient([page([], null)]);
  await pullSource({
    client,
    contract,
    state: { cursor: null, watermark: "2026-01-01T00:00:00.000Z", updatedAt: null },
    onChunk: async () => {},
  });
  assert.equal(client.calls[0]?.updatedSince, "2026-01-01T00:00:00.000Z");
});

test("retries a retryable error using the server's Retry-After", async () => {
  let attempts = 0;
  const client: SourceClient = {
    async fetchPage() {
      attempts += 1;
      if (attempts === 1) {
        throw new HttpSourceError("429", { status: 429, retryable: true, retryAfterMs: 5 });
      }
      return page([{ channel_id: 1, updated_at: "2026-01-01T00:00:00.000Z" }], null);
    },
  };
  const sleeps: number[] = [];
  const result = await pullSource({
    client,
    contract,
    onChunk: async () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result.chunks, 1);
  assert.deepEqual(sleeps, [5]);
});

test("propagates a terminal (non-retryable) error immediately", async () => {
  const client: SourceClient = {
    async fetchPage() {
      throw new HttpSourceError("400 bad request", { status: 400, retryable: false });
    },
  };
  await assert.rejects(
    () => pullSource({ client, contract, onChunk: async () => {} }),
    /400 bad request/,
  );
});

test("HttpSourceClient builds params and parses the page", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({ data: [{ channel_id: 1 }], next_cursor: "c9", server_time: "t" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new HttpSourceClient("http://mock.local", fetchImpl);
  const p = await client.fetchPage({
    endpoint: "/v1/streamers",
    updatedSince: "2026-01-01T00:00:00.000Z",
    cursor: null,
    limit: 5,
  });
  assert.equal(p.nextCursor, "c9");
  assert.equal(p.serverTime, "t");
  assert.match(urls[0] ?? "", /updated_since=/);
  assert.match(urls[0] ?? "", /limit=5/);
});

test("HttpSourceClient classifies 429 as retryable with Retry-After", async () => {
  const fetchImpl = (async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "2" },
    })) as typeof fetch;
  const client = new HttpSourceClient("http://mock.local", fetchImpl);
  await assert.rejects(
    () => client.fetchPage({ endpoint: "/v1/streamers", limit: 1 }),
    (err: unknown) =>
      err instanceof HttpSourceError && err.retryable && err.retryAfterMs === 2000,
  );
});
