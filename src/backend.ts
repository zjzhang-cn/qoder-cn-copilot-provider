import type { OpenAIMessage, OpenAITool } from "./core/messages";
import type { HubModel } from "./core/types";

export interface ChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  toolChoice?: "auto" | "required" | "none";
  reasoningEffort?: string;
  contextSize?: number;
  maxOutputTokens?: number;
  modelName?: string;
  maxInputTokens?: number;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
}

export interface ToolCallResult {
  callId: string;
  name: string;
  input: unknown;
}

export interface StreamHandlers {
  onText(text: string): void;
  onToolCall(call: ToolCallResult): void;
  onUsage?(usage: unknown): void;
}

export class HubError extends Error {
  /**
   * Stable machine-readable identifier for presentation-layer localization.
   * The English `message` stays the source of truth for logs and tests; the
   * UI maps `code` to a localized string and falls back to `message`.
   */
  code?: string;

  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HubError";
  }
}

export class HubCancelledError extends Error {
  constructor(message = "Request cancelled") {
    super(message);
    this.name = "HubCancelledError";
  }
}

export class HubTimeoutError extends HubError {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = "HubTimeoutError";
  }
}

/** Backend-facing contract used by the VS Code provider. */
export interface BackendClient {
  fetchModels(signal?: AbortSignal): Promise<HubModel[]>;
  streamChat(
    request: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface BackendSetupCommands {
  /** Hub profile: open the base URL prompt. */
  readonly setBaseUrl?: string;
  /** Hub profile: open the API-key prompt. */
  readonly setApiKey?: string;
  /** Direct profile: run the OAuth sign-in flow. */
  readonly signIn?: string;
  /** Direct profile: clear the stored credentials. */
  readonly signOut?: string;
  /** Recreate the provider group after the native Delete action. */
  readonly createGroup?: string;
  readonly showLogs: string;
}

export interface BackendProfile {
  readonly id: "hub" | "direct";
  readonly vendor: string;
  readonly displayName: string;
  readonly groupName: string;
  readonly secretKey: string;
  readonly cacheKey: string;
  readonly configSection: string;
  readonly setup: BackendSetupCommands;
}
