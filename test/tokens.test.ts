import { describe, expect, it } from "vitest";
import {
  estimateMessageTokens,
  estimateTokens,
  estimateTokensFor,
} from "../src/core/tokens";

describe("estimateTokens", () => {
  it("counts four ASCII characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("counts each CJK character as one token", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("你好ab")).toBe(3);
  });
});

describe("estimateMessageTokens", () => {
  it("counts text, tool calls, and tool results", () => {
    const textMessage = estimateMessageTokens({
      role: 1,
      content: [{ value: "abcd" }],
      name: undefined,
    });
    expect(textMessage).toBe(5);

    const toolCallMessage = estimateMessageTokens({
      role: 2,
      content: [
        { callId: "call_1", name: "read_file", input: { path: "a.txt" } },
      ],
      name: undefined,
    });
    expect(toolCallMessage).toBeGreaterThan(4);

    const toolResultMessage = estimateMessageTokens({
      role: 1,
      content: [{ callId: "call_1", content: [{ value: "abcd" }] }],
      name: undefined,
    });
    expect(toolResultMessage).toBeGreaterThan(4);
  });
});

describe("estimateTokensFor", () => {
  it("dispatches strings and messages", () => {
    expect(estimateTokensFor("abcd")).toBe(1);
    expect(
      estimateTokensFor({
        role: 1,
        content: [{ value: "abcd" }],
        name: undefined,
      }),
    ).toBe(5);
  });
});
