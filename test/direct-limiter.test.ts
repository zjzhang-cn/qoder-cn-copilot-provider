import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirectLimiter } from "../src/direct/limiter";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qoder-direct-limiter-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("DirectLimiter", () => {
  it("allows only one action at a time", async () => {
    const limiter = new DirectLimiter({ gapMs: 0 });
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        limiter.run(async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
        }),
      ),
    );
    expect(maximum).toBe(1);
  });

  it("enforces the minimum gap", async () => {
    const limiter = new DirectLimiter({ gapMs: 40 });
    const starts: number[] = [];
    await limiter.run(async () => {
      starts.push(Date.now());
    });
    await limiter.run(async () => {
      starts.push(Date.now());
    });
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(30);
  });

  it("serializes across two limiters sharing a lock file", async () => {
    const lockPath = join(await tempDir(), "chat.lock");
    const first = new DirectLimiter({ gapMs: 0, lockPath });
    const second = new DirectLimiter({ gapMs: 0, lockPath });
    let active = 0;
    let maximum = 0;
    const action = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    };
    await Promise.all([first.run(action), second.run(action)]);
    expect(maximum).toBe(1);
  });
});
