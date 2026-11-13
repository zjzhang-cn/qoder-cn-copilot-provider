import { isRecord, safeJsonStringify } from "./util";

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAIMessage =
  | {
      role: "system" | "developer";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    }
  | {
      role: "user";
      content: string | OpenAIContentPart[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export interface RequestMessageLike {
  readonly role: number;
  readonly content: readonly unknown[];
  readonly name?: string | undefined;
}

export interface ToolLike {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: object | undefined;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

const ASSISTANT_ROLE = 2;

interface TextPartLike {
  value: string;
}

interface ToolCallPartLike {
  callId: string;
  name: string;
  input: unknown;
}

interface ToolResultPartLike {
  callId: string;
  content: readonly unknown[];
}

interface DataPartLike {
  mimeType: string;
  data: Uint8Array;
}

export function toOpenAIMessages(
  messages: readonly RequestMessageLike[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const message of messages) {
    if (message.role === ASSISTANT_ROLE) {
      const text: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      for (const part of message.content) {
        if (isTextPart(part)) {
          text.push(part.value);
        } else if (isToolCallPart(part)) {
          toolCalls.push({
            id: part.callId,
            type: "function",
            function: {
              name: part.name,
              arguments: stringifyToolInput(part.input),
            },
          });
        }
      }
      if (text.length > 0 || toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content: text.join("") || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      continue;
    }

    const toolResults: OpenAIMessage[] = [];
    const text: string[] = [];
    const images: OpenAIContentPart[] = [];
    for (const part of message.content) {
      if (isToolResultPart(part)) {
        toolResults.push({
          role: "tool",
          tool_call_id: part.callId,
          content: contentText(part.content),
        });
      } else if (isTextPart(part)) {
        text.push(part.value);
      } else if (isDataPart(part) && part.mimeType.startsWith("image/")) {
        images.push({
          type: "image_url",
          image_url: { url: dataUrl(part) },
        });
      }
    }

    result.push(...toolResults);
    if (text.length > 0 || images.length > 0) {
      const textParts: OpenAIContentPart[] = text
        .filter((value) => value.length > 0)
        .map((value) => ({ type: "text", text: value }));
      result.push({
        role: "user",
        content:
          images.length > 0 ? [...textParts, ...images] : text.join(""),
      });
    }
  }

  return result;
}

export function toOpenAITools(tools: readonly ToolLike[]): OpenAITool[] {
  return tools
    .filter((tool) => tool.name.trim().length > 0)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      },
    }));
}

export function isTextPart(value: unknown): value is TextPartLike {
  return (
    isRecord(value) &&
    typeof value.value === "string" &&
    !("callId" in value) &&
    !("mimeType" in value)
  );
}

export function isToolCallPart(value: unknown): value is ToolCallPartLike {
  return (
    isRecord(value) &&
    typeof value.callId === "string" &&
    typeof value.name === "string" &&
    "input" in value
  );
}

export function isToolResultPart(value: unknown): value is ToolResultPartLike {
  return (
    isRecord(value) &&
    typeof value.callId === "string" &&
    Array.isArray(value.content)
  );
}

export function isDataPart(value: unknown): value is DataPartLike {
  return (
    isRecord(value) &&
    typeof value.mimeType === "string" &&
    value.data instanceof Uint8Array
  );
}

export function contentText(content: readonly unknown[]): string {
  return content
    .map((part) => {
      if (isTextPart(part)) return part.value;
      if (isDataPart(part)) {
        if (part.mimeType.startsWith("text/")) {
          return new TextDecoder().decode(part.data);
        }
        return `[${part.mimeType}]`;
      }
      if (typeof part === "string") return part;
      return safeJsonStringify(part);
    })
    .join("\n");
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  return safeJsonStringify(input ?? {});
}

function dataUrl(part: DataPartLike): string {
  return `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`;
}
