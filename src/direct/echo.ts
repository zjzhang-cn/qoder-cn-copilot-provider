import type { ToolCallResult } from "../backend";
import { randomUUID } from "node:crypto";

export const TOOL_CALL_MARKER = "[assistant 请求调用工具]";
const HOLD_BACK = 64;

/**
 * Basic recovery for models that print a tool call as text:
 * `[assistant 请求调用工具]\n[{"name":"read_file","arguments":"{...}"}]`.
 *
 * Text is held back by a small tail so a marker split across stream chunks is
 * not emitted to the user. If the JSON is incomplete at stream end, the raw
 * text is flushed unchanged.
 */
export class EchoToolCallRecovery {
  private pending = "";
  private recovered = false;

  constructor(
    private readonly emitText: (text: string) => void,
    private readonly emitCall: (call: ToolCallResult) => void,
  ) {}

  push(text: string): void {
    if (!text || this.recovered) return;
    this.pending += text;
    const marker = this.pending.indexOf(TOOL_CALL_MARKER);
    if (marker >= 0) {
      const before = this.pending.slice(0, marker);
      if (before) this.emitText(before);
      const rest = this.pending.slice(marker + TOOL_CALL_MARKER.length);
      const calls = parseEchoCalls(rest);
      if (calls) {
        this.recovered = true;
        this.pending = "";
        for (const call of calls) this.emitCall(call);
      } else {
        this.pending = this.pending.slice(marker);
      }
      return;
    }

    if (this.pending.length > HOLD_BACK) {
      const emit = this.pending.slice(0, -HOLD_BACK);
      this.pending = this.pending.slice(-HOLD_BACK);
      this.emitText(emit);
    }
  }

  finish(): void {
    if (!this.pending) return;
    const text = this.pending;
    this.pending = "";
    if (!this.recovered) this.emitText(text);
  }
}

export function parseEchoCalls(text: string): ToolCallResult[] | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const calls: ToolCallResult[] = [];
  for (const value of parsed) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const rawArguments = entry.arguments;
    let input: unknown = {};
    if (typeof rawArguments === "string") {
      try {
        input = JSON.parse(rawArguments);
      } catch {
        input = { _raw: rawArguments };
      }
    } else if (rawArguments !== undefined) {
      input = rawArguments;
    }
    calls.push({ callId: `call_${randomUUID()}`, name, input });
  }
  return calls.length > 0 ? calls : undefined;
}
