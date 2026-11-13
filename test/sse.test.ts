import { describe, expect, it } from "vitest";
import { SseParser } from "../src/core/sse";

describe("SseParser", () => {
  it("parses events split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("data: hel")).toEqual([]);
    expect(parser.push("lo\n\n")).toEqual([{ data: "hello" }]);
  });

  it("joins multi-line data fields", () => {
    const parser = new SseParser();
    expect(parser.push("data: one\ndata: two\n\n")).toEqual([
      { data: "one\ntwo" },
    ]);
  });

  it("ignores comments and blank lines without data", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n\n")).toEqual([]);
  });

  it("handles CRLF", () => {
    const parser = new SseParser();
    expect(parser.push("data: ok\r\n\r\n")).toEqual([{ data: "ok" }]);
  });

  it("carries event and id fields", () => {
    const parser = new SseParser();
    expect(parser.push("event: delta\nid: 7\ndata: x\n\n")).toEqual([
      { event: "delta", id: "7", data: "x" },
    ]);
  });

  it("flushes an unterminated event on end", () => {
    const parser = new SseParser();
    expect(parser.push("data: tail")).toEqual([]);
    expect(parser.end()).toEqual([{ data: "tail" }]);
  });

  it("treats [DONE] as regular data", () => {
    const parser = new SseParser();
    expect(parser.push("data: [DONE]\n\n")).toEqual([{ data: "[DONE]" }]);
  });
});
