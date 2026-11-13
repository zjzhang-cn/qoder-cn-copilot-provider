import { describe, expect, it } from "vitest";
import type { OpenAIMessage, OpenAITool } from "../src/core/messages";
import {
  basepromptSystemText,
  buildDirectChatRequest,
  conversationIdFor,
  firstUserText,
} from "../src/direct/request";

const TOOL: OpenAITool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
  },
};

const ASSISTANT_TOOL_CALL: OpenAIMessage = {
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.txt"}' },
    },
  ],
};

const TOOL_RESULT: OpenAIMessage = {
  role: "tool",
  tool_call_id: "call_1",
  content: "file body",
};

function build(
  modelKey: string,
  messages: OpenAIMessage[] = [
    { role: "user", content: "hello" },
  ],
  options: Partial<Parameters<typeof buildDirectChatRequest>[0]> = {},
) {
  return buildDirectChatRequest({
    modelKey,
    modelName: "Qwen3.8-Max",
    messages,
    tools: [TOOL],
    toolModeRequired: false,
    reasoningEffort: "high",
    contextSize: 200_000,
    maxOutputTokens: 16_000,
    maxInputTokens: 400_000,
    supportsReasoning: true,
    supportsVision: true,
    conversationId: "conversation-1",
    conversationBeginAt: 1234,
    ...options,
  }).body;
}

describe("buildDirectChatRequest", () => {
  it("builds the Qoder body from the baseprompt skeleton", () => {
    const body = build("qmodel_38max");
    expect(body.model_config).toMatchObject({
      key: "qmodel_38max",
      display_name: "Qwen3.8-Max",
      format: "openai",
      source: "system",
      is_reasoning: true,
      max_input_tokens: 200_000,
    });
    expect(body.parameters).toMatchObject({
      max_tokens: 16_000,
      reasoning_effort: "high",
    });
    expect(body.business).toMatchObject({
      id: "conversation-1",
      begin_at: 1234,
      model_key: "qmodel_38max",
      version: "1.1.75",
    });
    expect(body.tools).toEqual([TOOL]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
    expect(body.chat_context).toMatchObject({
      text: { text: "hello" },
    });
  });

  it("uses structured tool history for whitelisted models", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "read a.txt" },
      ASSISTANT_TOOL_CALL,
      TOOL_RESULT,
    ];
    const body = build("qmodel_38max", messages);
    const flat = body.messages as Array<Record<string, unknown>>;
    const assistant = flat.find((message) => message.role === "assistant");
    const tool = flat.find((message) => message.role === "tool");
    expect(assistant?.tool_calls).toEqual(ASSISTANT_TOOL_CALL.tool_calls);
    expect(tool).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file body",
    });
  });

  it("falls back to text markers for non-whitelisted models", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "read a.txt" },
      ASSISTANT_TOOL_CALL,
      TOOL_RESULT,
    ];
    const body = build("mmodel", messages);
    const flat = body.messages as Array<Record<string, unknown>>;
    const assistant = flat.find(
      (message) =>
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.includes("[assistant 请求调用工具]"),
    );
    expect(assistant).toBeTruthy();
    const tool = flat.find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith("[工具结果"),
    );
    expect(tool?.content).toContain("file body");
  });

  it("adds a required-tool instruction", () => {
    const body = build("qmodel_38max", undefined, {
      toolModeRequired: true,
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(String(messages[0]?.content)).toContain(
      "You must call at least one tool in this turn.",
    );
  });

  it("exposes stable conversation and prompt helpers", () => {
    const messages: OpenAIMessage[] = [{ role: "user", content: "hello" }];
    expect(firstUserText(messages)).toBe("hello");
    expect(basepromptSystemText().length).toBeGreaterThan(1000);
    const first = conversationIdFor("workspace", "system", "hello");
    expect(conversationIdFor("workspace", "system", "hello")).toBe(first);
    expect(conversationIdFor("workspace", "system", "other")).not.toBe(first);
  });
});

describe("buildDirectChatRequest images", () => {
  const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const userWithImage: OpenAIMessage = {
    role: "user",
    content: [
      { type: "text", text: "what color is this?" },
      { type: "image_url", image_url: { url: IMAGE } },
    ],
  };

  function userMessages(body: Record<string, unknown>) {
    return (body.messages as Array<Record<string, unknown>>).filter(
      (message) => message.role === "user",
    );
  }

  it("keeps structured image_url parts for vision models", () => {
    const body = build("qmodel_38max", [userWithImage], {
      supportsVision: true,
    });
    const [user] = userMessages(body);
    expect(Array.isArray(user?.content)).toBe(true);
    expect(user?.content).toEqual([
      { type: "text", text: "what color is this?" },
      { type: "image_url", image_url: { url: IMAGE } },
    ]);
    expect((body.model_config as Record<string, unknown>).is_vl).toBe(true);
  });

  it("leaves the ignored top-level image fields null", () => {
    const body = build("qmodel_38max", [userWithImage]);
    expect(body.image_urls).toBeNull();
    expect(
      (body.chat_context as Record<string, unknown>).imageUrls,
    ).toBeNull();
  });

  it("replaces images with a text note for non-vision models", () => {
    const body = build("mmodel", [userWithImage], { supportsVision: false });
    const [user] = userMessages(body);
    expect(typeof user?.content).toBe("string");
    expect(user?.content).toContain("what color is this?");
    expect(user?.content).toContain("[图片已省略：当前模型不支持视觉]");
    expect(JSON.stringify(userMessages(body))).not.toContain("image_url");
    expect((body.model_config as Record<string, unknown>).is_vl).toBe(false);
  });

  it("keeps image-free messages as plain string content", () => {
    const body = build("qmodel_38max", [
      { role: "user", content: "just text" },
    ]);
    const [user] = userMessages(body);
    expect(user?.content).toBe("just text");
  });

  it("handles an image-only user message", () => {
    const body = build("qmodel_38max", [
      { role: "user", content: [{ type: "image_url", image_url: { url: IMAGE } }] },
    ]);
    const [user] = userMessages(body);
    expect(user?.content).toEqual([
      { type: "image_url", image_url: { url: IMAGE } },
    ]);
  });
});
