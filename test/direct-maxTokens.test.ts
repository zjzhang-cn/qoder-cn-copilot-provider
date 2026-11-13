import { describe, expect, it } from "vitest";
import { learnMaxOutputLimit } from "../src/direct/maxTokens";

describe("learnMaxOutputLimit", () => {
  it("parses the upstream range error", () => {
    expect(
      learnMaxOutputLimit(
        "invalid_parameter_error: Range of max_tokens should be [1, 131072]",
      ),
    ).toBe(131072);
    expect(
      learnMaxOutputLimit("Range of max_tokens should be [1, 8192]"),
    ).toBe(8192);
  });

  it("ignores unrelated errors", () => {
    expect(learnMaxOutputLimit("invalid api key")).toBeUndefined();
    expect(learnMaxOutputLimit("Range of max_tokens should be [1, 0]")).toBeUndefined();
  });
});
