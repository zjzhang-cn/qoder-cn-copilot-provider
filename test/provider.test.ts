import { describe, expect, it } from "vitest";
import {
  HubTimeoutError,
  type BackendClient,
  type ChatRequest,
  type StreamHandlers,
  type ToolCallResult,
} from "../src/backend";
import type { HubModel } from "../src/core/types";
import type { Logger } from "../src/logger";
import { DIRECT_PROFILE } from "../src/profiles";
import { QoderProvider } from "../src/provider";
import { ModelStore } from "../src/core/modelStore";
import type * as vscodeTypes from "vscode";
import * as vscode from "./mocks/vscode";

const MODEL: HubModel = {
  id: "qmodel_38max",
  name: "Qwen3.8-Max",
  upstream_key: "qmodel_38max",
  enabled: true,
  context_length: 200_000,
  supports_tool_calls: true,
  capabilities: { tool_calls: true, reasoning: true },
};

class FakeBackend implements BackendClient {
  readonly requests: ChatRequest[] = [];
  tools: ToolCallResult[] = [];
  usage: unknown;

  async fetchModels(): Promise<HubModel[]> {
    return [MODEL];
  }

  async streamChat(
    request: ChatRequest,
    handlers: StreamHandlers,
  ): Promise<void> {
    this.requests.push(request);
    handlers.onText("Hello");
    for (const call of this.tools) handlers.onToolCall(call);
    if (this.usage !== undefined) handlers.onUsage?.(this.usage);
  }
}

function createProvider() {
  const backend = new FakeBackend();
  const values = new Map<string, unknown>();
  const store = new ModelStore({
    client: backend,
    memento: {
      get<T>(key: string): T | undefined {
        return values.get(key) as T | undefined;
      },
      update(key: string, value: unknown): void {
        values.set(key, value);
      },
    },
    cacheKey: DIRECT_PROFILE.cacheKey,
    getExcludedModels: () => [],
    getModelOverrides: () => ({}),
  });
  const log = {
    info: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
  const provider = new QoderProvider(store, backend, log, DIRECT_PROFILE);
  return { provider, backend };
}

function token(): vscodeTypes.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  } as unknown as vscodeTypes.CancellationToken;
}

function chatOptions(
  modelConfiguration?: Record<string, unknown>,
): vscodeTypes.ProvideLanguageModelChatResponseOptions {
  return {
    tools: [],
    toolMode: 1 as vscodeTypes.LanguageModelChatToolMode,
    ...(modelConfiguration ? { modelConfiguration } : {}),
  } as unknown as vscodeTypes.ProvideLanguageModelChatResponseOptions;
}

function progress(parts: unknown[]): vscodeTypes.Progress<vscodeTypes.LanguageModelResponsePart> {
  return {
    report: (part: vscodeTypes.LanguageModelResponsePart) => {
      parts.push(part);
    },
  } as vscodeTypes.Progress<vscodeTypes.LanguageModelResponsePart>;
}

describe("QoderProvider (direct)", () => {
  it("does not return groupless models", async () => {
    const { provider } = createProvider();
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true },
      token(),
    );
    expect(models).toEqual([]);
    provider.dispose();
  });

  it("returns models through the provider group", async () => {
    const { provider } = createProvider();
    const models = await provider.provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: {},
      } as unknown as vscodeTypes.PrepareLanguageModelChatModelOptions,
      token(),
    );
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "qmodel_38max",
      name: "Qwen3.8-Max",
      isUserSelectable: true,
      isBYOK: true,
    });
    provider.dispose();
  });

  it("forwards model configuration and streams text", async () => {
    const { provider, backend } = createProvider();
    await provider.provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: {},
      } as unknown as vscodeTypes.PrepareLanguageModelChatModelOptions,
      token(),
    );
    const parts: unknown[] = [];
    await provider.provideLanguageModelChatResponse(
      {
        id: "qmodel_38max",
        name: "Qwen3.8-Max",
        family: "qmodel_38max",
        version: "1.0.0",
        maxInputTokens: 200_000,
        maxOutputTokens: 16_000,
        capabilities: { toolCalling: true, imageInput: false },
      },
      [{ role: 1, content: [{ value: "hi" }], name: undefined }],
      chatOptions({ reasoningEffort: "high", contextSize: 200_000 }),
      progress(parts),
      token(),
    );
    expect(backend.requests[0]).toMatchObject({
      model: "qmodel_38max",
      reasoningEffort: "high",
      contextSize: 200_000,
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
    expect((parts[0] as vscode.LanguageModelTextPart).value).toBe("Hello");
    provider.dispose();
  });

  it("streams tool calls", async () => {
    const { provider, backend } = createProvider();
    backend.tools = [
      { callId: "call_1", name: "read_file", input: { path: "a.txt" } },
    ];
    await provider.provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: {},
      } as unknown as vscodeTypes.PrepareLanguageModelChatModelOptions,
      token(),
    );
    const parts: unknown[] = [];
    await provider.provideLanguageModelChatResponse(
      {
        id: "qmodel_38max",
        name: "Qwen3.8-Max",
        family: "qmodel_38max",
        version: "1.0.0",
        maxInputTokens: 200_000,
        maxOutputTokens: 16_000,
        capabilities: { toolCalling: true, imageInput: false },
      },
      [{ role: 1, content: [{ value: "read" }], name: undefined }],
      chatOptions(),
      progress(parts),
      token(),
    );
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBeInstanceOf(vscode.LanguageModelToolCallPart);
    expect(parts[1]).toMatchObject({
      callId: "call_1",
      name: "read_file",
      input: { path: "a.txt" },
    });
    provider.dispose();
  });

  it("localizes a chat timeout instead of leaking the raw transport text", async () => {
    const { provider, backend } = createProvider();
    backend.streamChat = async () => {
      throw new HubTimeoutError(600_000);
    };
    await provider.provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: {},
      } as unknown as vscodeTypes.PrepareLanguageModelChatModelOptions,
      token(),
    );
    await expect(
      provider.provideLanguageModelChatResponse(
        {
          id: "qmodel_38max",
          name: "Qwen3.8-Max",
          family: "qmodel_38max",
          version: "1.0.0",
          maxInputTokens: 200_000,
          maxOutputTokens: 16_000,
          capabilities: { toolCalling: true, imageInput: false },
        },
        [{ role: 1, content: [{ value: "hi" }], name: undefined }],
        chatOptions(),
        progress([]),
        token(),
      ),
    ).rejects.toThrow("Qoder Direct: request timed out after 600000 ms.");
    provider.dispose();
  });

  it("reports upstream usage as a usage DataPart", async () => {
    const { provider, backend } = createProvider();
    backend.usage = {
      prompt_tokens: 45047,
      completion_tokens: 78,
      total_tokens: 45125,
      prompt_tokens_details: { cached_tokens: 43648 },
      completion_tokens_details: { reasoning_tokens: 0 },
    };
    await provider.provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: {},
      } as unknown as vscodeTypes.PrepareLanguageModelChatModelOptions,
      token(),
    );
    const parts: unknown[] = [];
    await provider.provideLanguageModelChatResponse(
      {
        id: "qmodel_38max",
        name: "Qwen3.8-Max",
        family: "qmodel_38max",
        version: "1.0.0",
        maxInputTokens: 200_000,
        maxOutputTokens: 16_000,
        capabilities: { toolCalling: true, imageInput: false },
      },
      [{ role: 1, content: [{ value: "hi" }], name: undefined }],
      chatOptions(),
      progress(parts),
      token(),
    );
    const usagePart = parts.find(
      (part) => part instanceof vscode.LanguageModelDataPart,
    ) as vscode.LanguageModelDataPart | undefined;
    expect(usagePart).toBeDefined();
    expect(usagePart?.mimeType).toBe("usage");
    const decoded = JSON.parse(
      new TextDecoder().decode(usagePart?.data ?? new Uint8Array()),
    ) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      prompt_tokens: 45047,
      completion_tokens: 78,
      total_tokens: 45125,
    });
    // Cached-input line is rendered from _meta.turnTokenTotals[].cachedTokens.
    expect(decoded._meta).toMatchObject({
      turnTokenTotals: [
        {
          model: "qmodel_38max",
          inputTokens: 45047,
          cachedTokens: 43648,
          outputTokens: 78,
        },
      ],
    });
    provider.dispose();
  });

  it("ignores malformed usage without throwing", async () => {
    const { provider, backend } = createProvider();
    backend.usage = { not_tokens: true };
    await provider.provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: {},
      } as unknown as vscodeTypes.PrepareLanguageModelChatModelOptions,
      token(),
    );
    const parts: unknown[] = [];
    await provider.provideLanguageModelChatResponse(
      {
        id: "qmodel_38max",
        name: "Qwen3.8-Max",
        family: "qmodel_38max",
        version: "1.0.0",
        maxInputTokens: 200_000,
        maxOutputTokens: 16_000,
        capabilities: { toolCalling: true, imageInput: false },
      },
      [{ role: 1, content: [{ value: "hi" }], name: undefined }],
      chatOptions(),
      progress(parts),
      token(),
    );
    expect(
      parts.some((part) => part instanceof vscode.LanguageModelDataPart),
    ).toBe(false);
    provider.dispose();
  });

  it("offers Import PAT in the no-models recovery prompt", async () => {
    const { provider, backend } = createProvider();
    backend.fetchModels = async () => [];
    vscode.state.warningChoice = "Import PAT";
    vscode.state.executed.length = 0;

    await provider.provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: {},
      } as unknown as vscodeTypes.PrepareLanguageModelChatModelOptions,
      token(),
    );
    // Let the floating showWarningMessage().then() dispatch run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vscode.state.warningActions).toContain("Import PAT");
    expect(vscode.state.executed).toContainEqual({
      command: "qoderDirect.importPat",
      args: [],
    });
    provider.dispose();
  });
});
