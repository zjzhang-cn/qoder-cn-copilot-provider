import { withFileLock } from "./lock";

export interface DirectLimiterOptions {
  gapMs?: number;
  lockPath?: string;
  lockTimeoutMs?: number;
  lockTtlMs?: number;
}

/**
 * One in-flight chat per window plus a minimum gap between chats. When a lock
 * path is provided, the same gate is serialized across VS Code windows.
 */
export class DirectLimiter {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = 0;
  private readonly gapMs: number;

  constructor(private readonly options: DirectLimiterOptions = {}) {
    this.gapMs = options.gapMs ?? 300;
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.options.lockPath) {
        return await withFileLock(
          this.options.lockPath,
          {
            timeoutMs: this.options.lockTimeoutMs ?? 15 * 60 * 1000,
            ttlMs: this.options.lockTtlMs ?? 20 * 60 * 1000,
          },
          () => this.runOnce(action),
        );
      }
      return await this.runOnce(action);
    } finally {
      release();
    }
  }

  private async runOnce<T>(action: () => Promise<T>): Promise<T> {
    const wait = this.lastStart + this.gapMs - Date.now();
    if (wait > 0) await delay(wait);
    this.lastStart = Date.now();
    try {
      return await action();
    } finally {
      if (this.gapMs > 0) await delay(this.gapMs);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
