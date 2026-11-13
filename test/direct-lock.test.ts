import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock } from "../src/direct/lock";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qoder-direct-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("withFileLock", () => {
  it("serializes concurrent actions", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "test.lock");
    let active = 0;
    let maximum = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        withFileLock(lockPath, { timeoutMs: 5000, ttlMs: 5000 }, async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
        }),
      ),
    );
    expect(maximum).toBe(1);
  });

  it("removes a stale lock", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "stale.lock");
    await writeFile(lockPath, "stale");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    let ran = false;
    await withFileLock(lockPath, { timeoutMs: 1000, ttlMs: 10 }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("times out while a fresh lock is held", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "busy.lock");
    await writeFile(lockPath, "busy");

    await expect(
      withFileLock(lockPath, { timeoutMs: 30, ttlMs: 60_000, retryMs: 5 }, async () => undefined),
    ).rejects.toThrow(/Timed out/);
    const info = await stat(lockPath);
    expect(info.isFile()).toBe(true);
  });
});
