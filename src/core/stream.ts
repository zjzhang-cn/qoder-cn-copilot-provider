import { isRecord } from "./util";

export interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIStreamChunk {
  id?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
      reasoning_content?: string | null;
    };
    message?: {
      content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

export interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface MutableToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class ToolCallAccumulator {
  private readonly calls = new Map<number, MutableToolCall>();

  push(deltas: readonly OpenAIToolCallDelta[] | undefined): void {
    if (!deltas) return;
    for (const delta of deltas) {
      const index =
        typeof delta.index === "number" && Number.isFinite(delta.index)
          ? delta.index
          : 0;
      let call = this.calls.get(index);
      if (!call) {
        call = { id: "", name: "", arguments: "" };
        this.calls.set(index, call);
      }
      if (typeof delta.id === "string" && delta.id.length > 0) {
        call.id = delta.id;
      }
      if (delta.function) {
        if (typeof delta.function.name === "string" && delta.function.name) {
          call.name += delta.function.name;
        }
        if (
          typeof delta.function.arguments === "string" &&
          delta.function.arguments
        ) {
          call.arguments += delta.function.arguments;
        }
      }
    }
  }

  get size(): number {
    return this.calls.size;
  }

  finish(): AccumulatedToolCall[] {
    return [...this.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.arguments,
      }));
  }
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

export function textDelta(chunk: OpenAIStreamChunk): string {
  const content = chunk.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : "";
}

export function toolCallDeltas(
  chunk: OpenAIStreamChunk,
): readonly OpenAIToolCallDelta[] | undefined {
  return chunk.choices?.[0]?.delta?.tool_calls;
}

export function finishReason(chunk: OpenAIStreamChunk): string | undefined {
  return chunk.choices?.[0]?.finish_reason ?? undefined;
}

export function streamErrorMessage(chunk: OpenAIStreamChunk): string | undefined {
  return chunk.error?.message;
}
