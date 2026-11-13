import { describe, expect, it } from "vitest";
import {
  EchoToolCallRecovery,
  parseEchoCalls,
  TOOL_CALL_MARKER,
} from "../src/direct/echo";
import type { ToolCallResult } from "../src/backend";

function collector() {
  const text: string[] = [];
  const calls: ToolCallResult[] = [];
  const recovery = new EchoToolCallRecovery(
    (value) => text.push(value),
    (call) => calls.push(call),
  );
  return { recovery, text, calls };
}

describe("EchoToolCallRecovery", () => {
  it("recovers a marker and JSON array split across chunks", () => {
    const { recovery, text, calls } = collector();
    const json = JSON.stringify([
      { name: "read_file", arguments: '{"path":"a.txt"}' },
    ]);
    recovery.push("before ");
    recovery.push(TOOL_CALL_MARKER.slice(0, 5));
    recovery.push(TOOL_CALL_MARKER.slice(5) + "\n");
    recovery.push(json.slice(0, 10));
    recovery.push(json.slice(10));
    recovery.finish();

    expect(text.join("")).toBe("before ");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "read_file",
      input: { path: "a.txt" },
    });
    expect(text.join("")).not.toContain(TOOL_CALL_MARKER);
  });

  it("flushes raw text when the JSON is incomplete", () => {
    const { recovery, text, calls } = collector();
    recovery.push(`${TOOL_CALL_MARKER}\n[{"name":"x"`);
    recovery.finish();
    expect(calls).toEqual([]);
    expect(text.join("")).toContain(TOOL_CALL_MARKER);
  });

  it("streams normal text and flushes the held tail", () => {
    const { recovery, text } = collector();
    const value = "x".repeat(200);
    recovery.push(value);
    recovery.finish();
    expect(text.join("")).toBe(value);
  });

  it("parses arguments defensively", () => {
    expect(
      parseEchoCalls(
        '[{"name":"read_file","arguments":"not-json"}]',
      ),
    ).toMatchObject([{ name: "read_file", input: { _raw: "not-json" } }]);
    expect(parseEchoCalls("no calls")).toBeUndefined();
  });
});
