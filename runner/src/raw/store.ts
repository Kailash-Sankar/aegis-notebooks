import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "../config.js";

/**
 * The raw lake (ADR 0007). RustFS holds the immutable authoritative copy of
 * ingested chunks, off the query path. Keys are content-addressed by the
 * gateway so re-landing the same chunk is a no-op (ADR 0008: the queue carries
 * a pointer into this store, never the bytes).
 */
export interface RawStore {
  readonly enabled: boolean;
  /** Create the bucket if missing. Safe to call on every startup. */
  ensureReady(): Promise<void>;
  exists(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<void>;
}

/**
 * In-memory raw store for tests and local runs without RustFS configured. NOT
 * durable: it exists so the pipeline is runnable and testable offline.
 */
export class MemoryRawStore implements RawStore {
  readonly enabled = true;
  private readonly objects = new Map<string, Uint8Array>();

  async ensureReady(): Promise<void> {}

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }

  async get(key: string): Promise<Uint8Array> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`raw object not found: ${key}`);
    return found;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }
}

export class S3RawStore implements RawStore {
  readonly enabled = true;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: Config) {
    this.bucket = config.RUSTFS_RAW_BUCKET;
    this.client = new S3Client({
      endpoint: config.RUSTFS_ENDPOINT,
      region: config.RUSTFS_REGION,
      forcePathStyle: true, // RustFS is path-style S3
      credentials: {
        accessKeyId: config.RUSTFS_ACCESS_KEY ?? "",
        secretAccessKey: config.RUSTFS_SECRET_KEY ?? "",
      },
    });
  }

  async ensureReady(): Promise<void> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: ".keep" }),
      );
    } catch {
      // Bucket may not exist; create it (ignore any create race).
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch {
        // best-effort; a real put will surface any hard failure
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`Empty body for s3://${this.bucket}/${key}`);
    return res.Body.transformToByteArray();
  }

  async list(prefix: string): Promise<string[]> {
    const res = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );
    return (res.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => Boolean(k));
  }

  async deletePrefix(prefix: string): Promise<void> {
    const keys = await this.list(prefix);
    if (keys.length === 0) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }),
    );
  }
}

/**
 * RustFS when configured (`RUSTFS_*` present), else an in-memory store so the
 * pipeline still runs offline. `config.backupsEnabled` is true exactly when the
 * RustFS endpoint + credentials are set.
 */
export function createRawStore(config: Config): RawStore {
  return config.backupsEnabled ? new S3RawStore(config) : new MemoryRawStore();
}
