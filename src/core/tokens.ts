import {
  isDataPart,
  isTextPart,
  isToolCallPart,
  isToolResultPart,
  type RequestMessageLike,
} from "./messages";
import { safeJsonStringify } from "./util";

const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/**
 * Local token estimate. CJK characters count as one token each; everything
 * else counts as one token per four UTF-16 code units. Matches the hub's own
 * order of magnitude without adding a tokenizer dependency or network call.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const character of text) {
    if (CJK.test(character)) cjk += 1;
  }
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

export function estimateMessageTokens(message: RequestMessageLike): number {
  let total = 4;
  for (const part of message.content) {
    if (isTextPart(part)) {
      total += estimateTokens(part.value);
    } else if (isToolCallPart(part)) {
      total += estimateTokens(part.name);
      total += estimateTokens(safeJsonStringify(part.input ?? {}));
    } else if (isToolResultPart(part)) {
      total += estimateTokens(part.callId);
      total += estimateContentTokens(part.content);
    } else if (isDataPart(part)) {
      total += Math.ceil(part.data.byteLength / 4);
    } else {
      total += estimateTokens(safeJsonStringify(part));
    }
  }
  return total;
}

export function estimateTokensFor(
  text: string | RequestMessageLike,
): number {
  return typeof text === "string" ? estimateTokens(text) : estimateMessageTokens(text);
}

function estimateContentTokens(content: readonly unknown[]): number {
  let total = 0;
  for (const part of content) {
    if (isTextPart(part)) {
      total += estimateTokens(part.value);
    } else if (isDataPart(part)) {
      total += Math.ceil(part.data.byteLength / 4);
    } else if (typeof part === "string") {
      total += estimateTokens(part);
    } else {
      total += estimateTokens(safeJsonStringify(part));
    }
  }
  return total;
}
