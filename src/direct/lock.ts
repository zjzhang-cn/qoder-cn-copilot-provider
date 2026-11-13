import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockOptions {
  timeoutMs?: number;
  ttlMs?: number;
  retryMs?: number;
}

/**
 * Cross-window lock backed by a lock file in the extension's global storage.
 * A stale lock older than ttlMs is removed; waiters retry until timeoutMs.
 */
export async function withFileLock<T>(
  lockPath: string,
  options: FileLockOptions,
  action: () => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ttlMs = options.ttlMs ?? 60_000;
  const retryMs = options.retryMs ?? 100;
  await mkdir(dirname(lockPath), { recursive: true });

  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        return await action();
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const now = Date.now();
    if (now - started > timeoutMs) {
      throw new Error("Timed out waiting for the Qoder Direct lock.");
    }
    try {
      const info = await stat(lockPath);
      if (now - info.mtimeMs > ttlMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
    } catch {
      // The holder released the lock between open() and stat().
    }
    await delay(retryMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
