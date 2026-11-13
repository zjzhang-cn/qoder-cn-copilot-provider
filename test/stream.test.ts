import { describe, expect, it } from "vitest";
import {
  ToolCallAccumulator,
  parseToolArguments,
  textDelta,
  toolCallDeltas,
} from "../src/core/stream";

describe("ToolCallAccumulator", () => {
  it("stitches fragmented tool calls by index", () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.push([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "read_", arguments: '{"pa' },
      },
    ]);
    accumulator.push([
      { index: 0, function: { name: "file", arguments: 'th":"a.txt"}' } },
    ]);
    accumulator.push([
      {
        index: 1,
        id: "call_2",
        function: { name: "list", arguments: "{}" },
      },
    ]);

    expect(accumulator.finish()).toEqual([
      {
        id: "call_1",
        name: "read_file",
        arguments: '{"path":"a.txt"}',
      },
      { id: "call_2", name: "list", arguments: "{}" },
    ]);
  });

  it("defaults missing ids and indexes", () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.push([{ function: { name: "ping", arguments: "{}" } }]);
    expect(accumulator.finish()).toEqual([
      { id: "call_0", name: "ping", arguments: "{}" },
    ]);
  });
});

describe("parseToolArguments", () => {
  it("parses objects", () => {
    expect(parseToolArguments('{"path":"a"}')).toEqual({ path: "a" });
  });

  it("keeps invalid JSON visible", () => {
    expect(parseToolArguments('{"path"')).toEqual({ _raw: '{"path"' });
  });

  it("returns an empty object for empty input", () => {
    expect(parseToolArguments("  ")).toEqual({});
  });
});

describe("stream helpers", () => {
  it("extracts text, tool deltas, and ignores reasoning", () => {
    const chunk = {
      choices: [
        {
          delta: {
            content: "hi",
            reasoning_content: "thinking",
            tool_calls: [{ index: 0, id: "call_1" }],
          },
        },
      ],
    };
    expect(textDelta(chunk)).toBe("hi");
    expect(toolCallDeltas(chunk)?.[0]?.id).toBe("call_1");
  });
});
