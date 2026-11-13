import { describe, expect, it } from "vitest";
import { parseQueueRetryAfter } from "../src/direct/queue";

describe("parseQueueRetryAfter", () => {
  it("parses a 10605 queue response", () => {
    expect(
      parseQueueRetryAfter(
        JSON.stringify({
          code: "10605",
          isQueued: true,
          retryAfterSeconds: 12,
        }),
        403,
      ),
    ).toBe(12_000);
    expect(
      parseQueueRetryAfter(
        JSON.stringify({ error: { code: 10605, retry_after: 3 } }),
        429,
      ),
    ).toBe(3_000);
  });

  it("ignores non-queue responses and caps the delay", () => {
    expect(parseQueueRetryAfter('{"error":"invalid"}', 403)).toBeUndefined();
    expect(parseQueueRetryAfter("plain text", 429)).toBeUndefined();
    expect(
      parseQueueRetryAfter(
        JSON.stringify({ code: "10605", retryAfterSeconds: 600 }),
        503,
      ),
    ).toBe(60_000);
  });
});
