import { createHash, randomUUID } from "node:crypto";
import type { OpenAIContentPart, OpenAIMessage, OpenAITool } from "../core/messages";
import { isRecord } from "../core/util";
import baseprompt from "../../assets/baseprompt.json";
import { COSY_VERSION, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_USER_TYPE } from "./constants";

export interface DirectChatRequestInput {
  modelKey: string;
  modelName: string;
  messages: readonly OpenAIMessage[];
  tools?: readonly OpenAITool[];
  toolModeRequired: boolean;
  reasoningEffort?: string;
  contextSize?: number;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  conversationId: string;
  conversationBeginAt: number;
  userType?: string;
}

export interface DirectChatRequestBody {
  body: Record<string, unknown>;
  modelKey: string;
}

export function buildDirectChatRequest(
  input: DirectChatRequestInput,
): DirectChatRequestBody {
  const openAIMessages = input.messages;
  const toolNames = collectToolNames(openAIMessages);
  const structured = structuredToolHistoryEnabled(
    input.modelKey,
    openAIMessages,
  );
  const { systemText, flat, prompt } = flattenMessages(
    openAIMessages,
    toolNames,
    structured,
    input.supportsVision === true,
  );

  const body = structuredClone(baseprompt) as Record<string, unknown>;
  const templateMessages = Array.isArray(body.messages)
    ? body.messages.filter(
        (message): message is Record<string, unknown> =>
          isRecord(message) && message.role === "system",
      )
    : [];
  const templateSystem = templateMessages
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    )
    .filter(Boolean)
    .join("\n\n");
  let systemContent = systemText ?? templateSystem;
  if (input.toolModeRequired) {
    systemContent = `${systemContent}${systemContent ? "\n\n" : ""}You must call at least one tool in this turn.`;
  }
  body.messages = systemContent
    ? [{ role: "system", content: systemContent }, ...flat]
    : flat;

  body.request_id = randomUUID();
  body.chat_record_id = input.conversationId;
  body.request_set_id = randomUUID();
  body.session_id = input.conversationId;
  body.stream = true;
  body.agent_id = "agent_common";
  body.aliyun_user_type = input.userType ?? DEFAULT_USER_TYPE;

  const modelConfig = isRecord(body.model_config)
    ? body.model_config
    : {};
  modelConfig.key = input.modelKey;
  modelConfig.display_name = input.modelName;
  modelConfig.model = "";
  modelConfig.format = "openai";
  modelConfig.api_key = "";
  modelConfig.url = "";
  modelConfig.source = "system";
  modelConfig.is_vl = input.supportsVision === true;
  modelConfig.is_reasoning = input.supportsReasoning === true;
  modelConfig.max_input_tokens =
    input.contextSize ?? input.maxInputTokens ?? 180_000;
  body.model_config = modelConfig;

  const chatContext = isRecord(body.chat_context) ? body.chat_context : {};
  const text = isRecord(chatContext.text) ? chatContext.text : {};
  text.text = prompt;
  chatContext.text = text;
  const extra = isRecord(chatContext.extra) ? chatContext.extra : {};
  const originalContent = isRecord(extra.originalContent)
    ? extra.originalContent
    : {};
  originalContent.text = prompt;
  extra.originalContent = originalContent;
  extra.modelConfig = { ...modelConfig };
  chatContext.extra = extra;
  // Upstream reads images ONLY from structured image_url parts inside
  // messages[].content; the top-level fields are ignored and would triple
  // the body size. Keep them null (as in baseprompt.json).
  chatContext.imageUrls = null;
  body.chat_context = chatContext;
  body.image_urls = null;

  const parameters = isRecord(body.parameters) ? body.parameters : {};
  parameters.max_tokens =
    input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (input.reasoningEffort) {
    parameters.reasoning_effort = input.reasoningEffort;
  }
  body.parameters = parameters;
  body.tools = input.tools ?? [];

  const business = isRecord(body.business) ? body.business : {};
  business.id = input.conversationId;
  business.begin_at = input.conversationBeginAt;
  business.name = prompt.slice(0, 30) || "chat";
  business.product = "cli";
  business.type = "agent";
  business.stage = "start";
  business.model_key = input.modelKey;
  business.version = COSY_VERSION;
  body.business = business;

  return { body, modelKey: input.modelKey };
}

export function basepromptSystemText(): string {
  const body = baseprompt as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .filter(
      (message): message is Record<string, unknown> =>
        isRecord(message) && message.role === "system",
    )
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    )
    .filter(Boolean)
    .join("\n\n");
}

export function firstUserText(
  messages: readonly OpenAIMessage[],
): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = contentText(message.content).trim();
    if (text) return text;
  }
  return "";
}

export function conversationIdFor(
  workspacePath: string,
  systemPrompt: string,
  firstUserMessage: string,
): string {
  const hash = createHash("sha256")
    .update(`${workspacePath}\n${systemPrompt}\n${firstUserMessage}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function flattenMessages(
  messages: readonly OpenAIMessage[],
  toolNames: ReadonlyMap<string, string>,
  structured: boolean,
  supportsVision: boolean,
): { systemText?: string; flat: Array<Record<string, unknown>>; prompt: string } {
  let systemText: string | undefined;
  const flat: Array<Record<string, unknown>> = [];
  let prompt = "";

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = contentText(message.content);
      if (!systemText && text) systemText = text;
      continue;
    }

    if (message.role === "tool") {
      const body = contentText(message.content);
      if (structured) {
        flat.push({
          role: "tool",
          tool_call_id: message.tool_call_id,
          content: body,
        });
      } else {
        const name = toolNames.get(message.tool_call_id);
        flat.push({
          role: "user",
          content: `[工具结果${name ? ` (${name})` : ""}]\n${body}`,
        });
      }
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      if (structured) {
        flat.push({
          role: "assistant",
          content: contentText(message.content),
          tool_calls: message.tool_calls,
        });
      } else {
        const calls = message.tool_calls.map((call) => ({
          name: call.function.name,
          arguments: call.function.arguments,
        }));
        flat.push({
          role: "assistant",
          content: `${contentText(message.content)}\n\n[assistant 请求调用工具]\n${JSON.stringify(calls)}`,
        });
      }
      continue;
    }

    const text = contentText(message.content);
    if (message.role === "user" && !prompt) prompt = text;

    // Images survive only in user messages, as structured image_url parts
    // alongside text (the upstream wire format). Non-vision models get a
    // text placeholder instead, so history with images never blocks a turn.
    const images =
      message.role === "user" ? contentImages(message.content) : [];
    if (images.length > 0) {
      if (supportsVision) {
        const parts: OpenAIContentPart[] = [];
        if (text) parts.push({ type: "text", text });
        parts.push(...images);
        flat.push({ role: message.role, content: parts });
      } else {
        const note = "[图片已省略：当前模型不支持视觉]";
        flat.push({
          role: message.role,
          content: text ? `${text}\n${note}` : note,
        });
      }
      continue;
    }

    flat.push({ role: message.role, content: text });
  }

  if (!prompt) {
    for (let index = flat.length - 1; index >= 0; index -= 1) {
      const item = flat[index];
      if (item?.role === "user" && typeof item.content === "string") {
        prompt = item.content;
        break;
      }
    }
  }
  return { systemText, flat, prompt };
}

function collectToolNames(
  messages: readonly OpenAIMessage[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      names.set(call.id, call.function.name);
    }
  }
  return names;
}

function structuredToolHistoryEnabled(
  modelKey: string,
  messages: readonly OpenAIMessage[],
): boolean {
  const key = modelKey.toLowerCase();
  const known =
    /^(qmodel|qfmodel|q37fmodel|q36fmodel|gmodel|gfmodel|gm51model|dmodel|dfmodel|kmodel)/.test(
      key,
    ) ||
    /(qwen|glm|deepseek|kimi)/.test(key);
  if (!known) return false;

  for (const message of messages) {
    if (message.role === "tool" && !message.tool_call_id) return false;
    if (message.role === "assistant" && message.tool_calls) {
      if (message.tool_calls.some((call) => !call.id)) return false;
    }
  }
  return true;
}

function contentText(content: string | unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Extract inline image_url parts (data URLs) from a message content array. */
function contentImages(content: string | unknown): OpenAIContentPart[] {
  if (!Array.isArray(content)) return [];
  const images: OpenAIContentPart[] = [];
  for (const part of content) {
    if (
      isRecord(part) &&
      part.type === "image_url" &&
      isRecord(part.image_url) &&
      typeof part.image_url.url === "string" &&
      part.image_url.url.startsWith("data:image/")
    ) {
      images.push({
        type: "image_url",
        image_url: { url: part.image_url.url },
      });
    }
  }
  return images;
}
