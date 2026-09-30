import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "../config.js";

/**
 * RustFS recovery set (ADR 0001). This is durable, immutable storage -- it is
 * NOT on the query path. When unconfigured, backups are skipped without
 * affecting ingestion or queries.
 */
export interface BackupStore {
  readonly enabled: boolean;
  /** Create the bucket if missing. Safe to call on every startup. */
  ensureReady(): Promise<void>;
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  list(prefix: string): Promise<string[]>;
  /** Delete every object under a prefix (used for full workspace cleanup). */
  deletePrefix(prefix: string): Promise<void>;
}

export class NullBackupStore implements BackupStore {
  readonly enabled = false;
  async ensureReady(): Promise<void> {}
  async put(): Promise<void> {
    throw new Error("Backup store is not configured (RUSTFS_* unset)");
  }
  async get(): Promise<Uint8Array> {
    throw new Error("Backup store is not configured (RUSTFS_* unset)");
  }
  async list(): Promise<string[]> {
    return [];
  }
  async deletePrefix(): Promise<void> {}
}

export class S3BackupStore implements BackupStore {
  readonly enabled = true;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: Config) {
    this.bucket = config.RUSTFS_BUCKET;
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
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
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

export function createBackupStore(config: Config): BackupStore {
  return config.backupsEnabled ? new S3BackupStore(config) : new NullBackupStore();
}
