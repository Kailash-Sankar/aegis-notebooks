import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";

/**
 * Hard caps, not a retrieval subsystem (ADR 0005). Caps are config values.
 */
export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

export interface WorkspaceUsage {
  bytes: number;
  files: number;
}

export class QuotaService {
  constructor(private readonly config: Config) {}

  async usage(dataDir: string): Promise<WorkspaceUsage> {
    if (!existsSync(dataDir)) return { bytes: 0, files: 0 };
    let bytes = 0;
    let files = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          bytes += (await stat(full)).size;
          files++;
        }
      }
    };
    await walk(dataDir);
    return { bytes, files };
  }

  async assertUploadAllowed(dataDir: string, incomingBytes: number): Promise<void> {
    if (incomingBytes > this.config.QUOTA_FILE_BYTES) {
      throw new QuotaError(
        `File is ${incomingBytes} bytes, exceeds per-file cap ${this.config.QUOTA_FILE_BYTES}`,
      );
    }
    const { bytes, files } = await this.usage(dataDir);
    if (bytes + incomingBytes > this.config.QUOTA_TOTAL_BYTES) {
      throw new QuotaError(
        `Workspace would exceed total cap ${this.config.QUOTA_TOTAL_BYTES} bytes`,
      );
    }
    if (files + 1 > this.config.QUOTA_FILE_COUNT) {
      throw new QuotaError(
        `Workspace would exceed file-count cap ${this.config.QUOTA_FILE_COUNT}`,
      );
    }
  }
}
