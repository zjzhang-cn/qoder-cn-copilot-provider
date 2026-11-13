import { describe, expect, it } from "vitest";
import {
  toOpenAIMessages,
  toOpenAITools,
  type RequestMessageLike,
} from "../src/core/messages";

const user = (...content: unknown[]): RequestMessageLike => ({
  role: 1,
  content,
  name: undefined,
});

const assistant = (...content: unknown[]): RequestMessageLike => ({
  role: 2,
  content,
  name: undefined,
});

describe("toOpenAIMessages", () => {
  it("maps a user text message", () => {
    expect(toOpenAIMessages([user({ value: "hello" })])).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("maps an assistant text and tool call", () => {
    expect(
      toOpenAIMessages([
        assistant(
          { value: "calling" },
          { callId: "call_1", name: "read_file", input: { path: "a.txt" } },
        ),
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"a.txt"}',
            },
          },
        ],
      },
    ]);
  });

  it("emits tool results as separate tool messages", () => {
    expect(
      toOpenAIMessages([
        user({ callId: "call_1", content: [{ value: "file body" }] }),
      ]),
    ).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "file body" },
    ]);
  });

  it("puts tool results before any accompanying user text", () => {
    expect(
      toOpenAIMessages([
        user(
          { callId: "call_1", content: [{ value: "result" }] },
          { value: "continue" },
        ),
      ]),
    ).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "user", content: "continue" },
    ]);
  });

  it("converts image data parts to data URLs", () => {
    expect(
      toOpenAIMessages([
        user(
          { value: "look" },
          {
            mimeType: "image/png",
            data: new Uint8Array([1, 2, 3]),
          },
        ),
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AQID" },
          },
        ],
      },
    ]);
  });

  it("skips empty assistant messages", () => {
    expect(toOpenAIMessages([assistant()])).toEqual([]);
  });
});

describe("toOpenAITools", () => {
  it("maps VS Code tools to OpenAI function tools", () => {
    expect(
      toOpenAITools([
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ]),
    ).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("supplies an empty object schema", () => {
    const [tool] = toOpenAITools([
      { name: "ping", description: "Ping" },
    ]);
    expect(tool?.function.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });
});
