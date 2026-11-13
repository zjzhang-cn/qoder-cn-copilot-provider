import { request as httpsRequest } from "node:https";
import {
  HubCancelledError,
  HubError,
  HubTimeoutError,
  type BackendClient,
  type ChatRequest,
  type StreamHandlers,
} from "../backend";
import { SseParser } from "../core/sse";
import {
  ToolCallAccumulator,
  finishReason,
  parseToolArguments,
  streamErrorMessage,
  textDelta,
  toolCallDeltas,
  type OpenAIStreamChunk,
} from "../core/stream";
import type { HubModel } from "../core/types";
import type { DirectAuth, DirectAuthManager } from "./authStore";
import {
  fetchDirectModels,
  type CatalogRequest,
} from "./catalog";
import { CHAT_PATH, DEFAULT_MAX_OUTPUT_TOKENS } from "./constants";
import type { CosySession } from "./cosy";
import { CosySession as CosySessionClass } from "./cosy";
import { endpointsFor } from "./endpoints";
import { EchoToolCallRecovery } from "./echo";
import { parseOuterFrame } from "./envelope";
import { qoderEncode } from "./encode";
import { DirectLimiter } from "./limiter";
import { learnMaxOutputLimit } from "./maxTokens";
import { parseQueueRetryAfter } from "./queue";
import { isSessionDeadMessage } from "./oauth";
import {
  basepromptSystemText,
  buildDirectChatRequest,
  conversationIdFor,
  firstUserText,
} from "./request";

export interface DirectStreamResponse {
  status: number;
  body: AsyncIterable<Uint8Array | string>;
}

export interface DirectTransportOptions {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type DirectTransport = (
  url: string,
  options: DirectTransportOptions,
) => Promise<DirectStreamResponse>;

export interface DirectQoderClientOptions {
  authManager: Pick<
    DirectAuthManager,
    "getAuth" | "ensureFresh" | "forceRefresh"
  >;
  getWorkspacePath?: () => string;
  logger?: (message: string) => void;
  catalogRequest?: CatalogRequest;
  transport?: DirectTransport;
  limiter?: DirectLimiter;
  now?: () => number;
}

const CHAT_TIMEOUT_MS = 600_000;

export class DirectQoderClient implements BackendClient {
  private readonly beginAt = new Map<string, number>();
  private readonly maxOutputLimits = new Map<string, number>();
  private readonly transport: DirectTransport;
  private readonly now: () => number;

  constructor(private readonly options: DirectQoderClientOptions) {
    this.transport = options.transport ?? httpsStream;
    this.now = options.now ?? Date.now;
  }

  async fetchModels(signal?: AbortSignal): Promise<HubModel[]> {
    const auth = await this.getAuth(signal);
    try {
      return await this.fetchModelsWithAuth(auth, signal);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      const refreshed = await this.options.authManager.forceRefresh(
        auth,
        signal,
      );
      return this.fetchModelsWithAuth(refreshed, signal);
    }
  }

  async streamChat(
    request: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.options.limiter) {
      await this.options.limiter.run(() =>
        this.streamChatInner(request, handlers, signal),
      );
      return;
    }
    await this.streamChatInner(request, handlers, signal);
  }

  private async streamChatInner(
    request: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    let auth = await this.getAuth(signal);
    let emitted = false;
    let authRetried = false;
    let queueRetried = false;
    const markEmitted = () => {
      emitted = true;
    };

    for (;;) {
      try {
        await this.streamWithAuth(
          auth,
          request,
          handlers,
          signal,
          markEmitted,
        );
        return;
      } catch (error) {
        if (signal?.aborted) throw new HubCancelledError();
        if (!emitted && isUnauthorized(error) && !authRetried) {
          auth = await this.options.authManager.forceRefresh(auth, signal);
          authRetried = true;
          continue;
        }
        if (
          !emitted &&
          error instanceof HubError &&
          error.status === 429 &&
          !queueRetried
        ) {
          queueRetried = true;
          await delay(
            Math.min(error.retryAfterMs ?? 5_000, 30_000),
            signal,
          );
          continue;
        }
        throw error;
      }
    }
  }

  private async getAuth(signal?: AbortSignal): Promise<DirectAuth> {
    const auth = await this.options.authManager.getAuth();
    if (!auth) {
      const err = new HubError("Sign in to Qoder Direct first.", 401);
      err.code = "signin-required";
      throw err;
    }
    return this.options.authManager.ensureFresh(auth, signal);
  }

  private async fetchModelsWithAuth(
    auth: DirectAuth,
    signal?: AbortSignal,
  ): Promise<HubModel[]> {
    const endpoints = endpointsFor(auth.instance);
    const session = this.createSession(auth);
    this.log(`GET ${endpoints.gateway} model list`);
    return fetchDirectModels(endpoints, session, {
      signal,
      request: this.options.catalogRequest,
    });
  }

  private async streamWithAuth(
    auth: DirectAuth,
    request: ChatRequest,
    handlers: StreamHandlers,
    signal: AbortSignal | undefined,
    markEmitted: () => void,
  ): Promise<void> {
    const endpoints = endpointsFor(auth.instance);
    const body = this.buildBody(auth, request);
    const encoded = qoderEncode(JSON.stringify(body));
    const url = `${endpoints.gateway}${CHAT_PATH}`;
    const session = this.createSession(auth);
    const headers = session.headers(encoded, url, {
      sse: true,
      modelKey: request.model,
    });
    this.log(
      `POST ${endpoints.gateway} model=${request.model} effort=${request.reasoningEffort ?? "default"} context=${request.contextSize ?? "default"}`,
    );

    const response = await this.transport(url, {
      method: "POST",
      headers,
      body: encoded,
      signal,
      timeoutMs: CHAT_TIMEOUT_MS,
    });
    if (response.status !== 200) {
      const text = await readText(response.body);
      this.learnMaxOutputLimit(request.model, text);
      const queueDelay = parseQueueRetryAfter(text, response.status);
      throw new HubError(
        text.trim() || `Qoder chat failed with HTTP ${response.status}.`,
        queueDelay === undefined ? response.status : 429,
        queueDelay,
      );
    }
    await this.consume(response.body, handlers, markEmitted, request.model);
  }

  private buildBody(
    auth: DirectAuth,
    request: ChatRequest,
  ): Record<string, unknown> {
    const workspace = this.options.getWorkspacePath?.() ?? "";
    const conversationId = conversationIdFor(
      workspace,
      basepromptSystemText(),
      firstUserText(request.messages),
    );
    const beginAt = this.beginAt.get(conversationId) ?? this.now();
    this.beginAt.set(conversationId, beginAt);
    const requestedOutput =
      request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const learnedLimit = this.maxOutputLimits.get(request.model);
    const maxOutputTokens =
      learnedLimit === undefined
        ? requestedOutput
        : Math.min(requestedOutput, learnedLimit);

    return buildDirectChatRequest({
      modelKey: request.model,
      modelName: request.modelName ?? request.model,
      messages: request.messages,
      tools: request.tools,
      toolModeRequired: request.toolChoice === "required",
      reasoningEffort: request.reasoningEffort,
      contextSize: request.contextSize,
      maxOutputTokens,
      maxInputTokens: request.maxInputTokens,
      supportsReasoning: request.supportsReasoning,
      supportsVision: request.supportsVision,
      conversationId,
      conversationBeginAt: beginAt,
      userType: auth.userType,
    }).body;
  }

  private createSession(auth: DirectAuth): CosySession {
    return new CosySessionClass({
      uid: auth.uid,
      name: auth.name,
      organizationId: auth.organizationId,
      organizationName: auth.organizationName,
      userType: auth.userType,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
    });
  }

  private async consume(
    stream: AsyncIterable<Uint8Array | string>,
    handlers: StreamHandlers,
    markEmitted: () => void,
    modelKey: string,
  ): Promise<void> {
    const parser = new SseParser();
    const accumulator = new ToolCallAccumulator();
    const recovery = new EchoToolCallRecovery(
      (text) => {
        handlers.onText(text);
        markEmitted();
      },
      (call) => {
        handlers.onToolCall(call);
        markEmitted();
      },
    );
    let done = false;
    let flushed = false;

    const flushToolCalls = () => {
      if (flushed) return;
      flushed = true;
      for (const call of accumulator.finish()) {
        if (!call.name) continue;
        handlers.onToolCall({
          callId: call.id,
          name: call.name,
          input: parseToolArguments(call.arguments),
        });
        markEmitted();
      }
    };

    const handleData = (data: string) => {
      const frame = parseOuterFrame(data);
      if (frame.done) {
        done = true;
        return;
      }
      if (!frame.inner) return;

      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(frame.inner) as OpenAIStreamChunk;
      } catch {
        throw new HubError("Qoder inner stream contained invalid JSON.");
      }
      const errorMessage = streamErrorMessage(chunk);
      if (errorMessage) {
        this.learnMaxOutputLimit(modelKey, errorMessage);
        throw new HubError(errorMessage);
      }

      const text = textDelta(chunk);
      if (text) recovery.push(text);
      accumulator.push(toolCallDeltas(chunk));
      if (chunk.usage) handlers.onUsage?.(chunk.usage);
      if (finishReason(chunk)) {
        recovery.finish();
        flushToolCalls();
      }
    };

    for await (const chunk of stream) {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf8");
      for (const event of parser.push(text)) {
        handleData(event.data);
        if (done) break;
      }
      if (done) break;
    }
    if (!done) {
      for (const event of parser.end()) {
        handleData(event.data);
        if (done) break;
      }
    }
    recovery.finish();
    flushToolCalls();
  }

  private learnMaxOutputLimit(model: string, message: string): void {
    if (!model) return;
    const limit = learnMaxOutputLimit(message);
    if (limit === undefined) return;
    this.maxOutputLimits.set(model, limit);
    this.log(`Learned max_tokens limit ${limit} for ${model}.`);
  }

  private log(message: string): void {
    this.options.logger?.(message);
  }
}

function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof HubError &&
    (error.status === 401 || isSessionDeadMessage(error.message))
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HubCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new HubCancelledError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readText(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8");
    if (text.length > 4000) break;
  }
  return text;
}

function httpsStream(
  url: string,
  options: DirectTransportOptions,
): Promise<DirectStreamResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: options.method,
        headers: options.headers,
        signal: options.signal,
      },
      (res) => {
        resolve({ status: res.statusCode ?? 0, body: res });
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? CHAT_TIMEOUT_MS, () => {
      req.destroy(
        new HubTimeoutError(options.timeoutMs ?? CHAT_TIMEOUT_MS),
      );
    });
    req.write(options.body);
    req.end();
  });
}
