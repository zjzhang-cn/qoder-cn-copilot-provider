import { describe, expect, it } from "vitest";
import { formatError, redactTokens } from "../src/core/util";

describe("redactTokens", () => {
  it("masks pt- tokens but keeps the prefix recognizable", () => {
    expect(redactTokens("invalid personal_token: pt-abc123XYZ_-def")).toBe(
      "invalid personal_token: pt-***",
    );
  });

  it("masks every token occurrence in a string", () => {
    expect(redactTokens("pt-aaaa1111 and pt-bbbb2222")).toBe(
      "pt-*** and pt-***",
    );
  });

  it("leaves short prefixes and unrelated text alone", () => {
    expect(redactTokens("pt-")).toBe("pt-");
    expect(redactTokens("pt-ab")).toBe("pt-ab");
    expect(redactTokens("input length exceeds 121530 tokens")).toBe(
      "input length exceeds 121530 tokens",
    );
    expect(redactTokens("")).toBe("");
  });
});

describe("formatError redaction", () => {
  it("redacts tokens in the message and the cause chain", () => {
    const cause = new Error("upstream echoed pt-secret12345");
    const error = new Error("exchange failed for pt-abcdef999", { cause });
    const formatted = formatError(error);
    expect(formatted).not.toContain("pt-secret12345");
    expect(formatted).not.toContain("pt-abcdef999");
    expect(formatted).toContain("pt-***");
  });

  it("redacts non-Error values too", () => {
    expect(formatError("raw pt-xyz98765 string")).toBe("raw pt-*** string");
  });
});