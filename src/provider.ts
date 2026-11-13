import * as vscode from "vscode";
import {
  HubCancelledError,
  HubError,
  HubTimeoutError,
  type BackendClient,
  type BackendProfile,
  type ToolCallResult,
} from "./backend";
import {
  toOpenAIMessages,
  toOpenAITools,
  type RequestMessageLike,
} from "./core/messages";
import type { ProviderModel } from "./core/types";
import type { ModelStore } from "./core/modelStore";
import { estimateTokensFor } from "./core/tokens";
import { isRecord } from "./core/util";
import { localizedAuthMessage } from "./authErrors";
import { t } from "./l10n";
import type { Logger } from "./logger";

interface ProviderOptions extends vscode.PrepareLanguageModelChatModelOptions {
  /** Runtime field used by VS Code's native "Add Model" configuration form. */
  readonly configuration?: unknown;
}

interface ResponseOptions
  extends vscode.ProvideLanguageModelChatResponseOptions {
  /** Runtime field carrying the per-model Effort Level / Context Size choices. */
  readonly modelConfiguration?: Readonly<Record<string, unknown>>;
}

export class QoderProvider
  implements vscode.LanguageModelChatProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly activeRequests = new Set<AbortController>();
  private lastSetupPromptAt = 0;
  private groupObserved = false;

  readonly onDidChangeLanguageModelChatInformation =
    this.changeEmitter.event;

  constructor(
    private readonly store: ModelStore,
    private readonly client: BackendClient,
    private readonly log: Logger,
    private readonly profile: BackendProfile,
  ) {}

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const configuration = (options as ProviderOptions).configuration;
    const isGroupCall = configuration !== undefined;
    if (this.profile.id === "direct" && !isGroupCall) {
      // Direct models are only ever served through their provider group. If the
      // group was deleted, do not resurrect groupless models.
      if (!options.silent) this.promptForSetup();
      return [];
    }
    if (isGroupCall && !this.groupObserved) {
      this.groupObserved = true;
      // The first resolution may already contain groupless models. Ask VS Code
      // to resolve again so those are replaced by models owned by the group.
      queueMicrotask(() => this.changeEmitter.fire());
    }
    if (!isGroupCall && this.groupObserved) {
      // Models are owned by the provider group; returning them again would
      // create duplicate, groupless entries that survive group deletion.
      return [];
    }
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() =>
      controller.abort(),
    );
    try {
      const result = await this.store.load(false, controller.signal);
      if (result.stale) {
        this.log.info(
          "Serving the cached model list because the hub is unavailable.",
        );
      }
      if (result.error) {
        this.log.error("Failed to refresh the model list", result.error);
      }
      if (result.models.length === 0 && !options.silent) {
        this.promptForSetup();
      }
      return result.models;
    } catch (error) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      this.log.error("Failed to list models", error);
      return [];
    } finally {
      subscription.dispose();
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() =>
      controller.abort(),
    );
    this.activeRequests.add(controller);
    const started = Date.now();

    try {
      const providerModel = await this.findModel(model.id, controller.signal);
      if (!providerModel) {
        throw vscode.LanguageModelError.NotFound(
          `Model ${model.id} is not available from Qoder Direct.`,
        );
      }

      const openAIMessages = toOpenAIMessages(
        messages as readonly RequestMessageLike[],
      );
      if (openAIMessages.length === 0) {
        throw new Error("There are no messages to send.");
      }

      const tools =
        options.tools && options.tools.length > 0
          ? toOpenAITools(options.tools)
          : undefined;
      const toolChoice =
        tools && options.toolMode === vscode.LanguageModelChatToolMode.Required
          ? "required"
          : undefined;

      const modelConfiguration = (options as ResponseOptions).modelConfiguration;
      const reasoningEffort =
        typeof modelConfiguration?.reasoningEffort === "string" &&
        modelConfiguration.reasoningEffort.trim()
          ? modelConfiguration.reasoningEffort.trim()
          : undefined;
      const contextSize =
        typeof modelConfiguration?.contextSize === "number" &&
        Number.isFinite(modelConfiguration.contextSize) &&
        modelConfiguration.contextSize > 0
          ? Math.floor(modelConfiguration.contextSize)
          : defaultContextSize(providerModel);

      this.log.info(
        `Chat request: model=${providerModel.id} messages=${openAIMessages.length} tools=${tools?.length ?? 0} toolMode=${options.toolMode} effort=${reasoningEffort ?? "default"} context=${contextSize ?? "default"}`,
      );

      await this.client.streamChat(
        {
          model: providerModel.id,
          modelName: providerModel.name,
          messages: openAIMessages,
          maxOutputTokens: providerModel.maxOutputTokens,
          maxInputTokens: providerModel.maxInputTokens,
          supportsReasoning: providerModel.supportsReasoning,
          supportsVision: providerModel.supportsVision,
          ...(tools ? { tools } : {}),
          ...(toolChoice ? { toolChoice } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(contextSize ? { contextSize } : {}),
        },
        {
          onText: (text) => {
            progress.report(new vscode.LanguageModelTextPart(text));
          },
          onToolCall: (call) => {
            progress.report(
              new vscode.LanguageModelToolCallPart(
                call.callId,
                call.name,
                toolInput(call),
              ),
            );
          },
          onUsage: (usage) => {
            this.log.info(`Usage: ${JSON.stringify(usage)}`);
            this.reportUsage(progress, usage);
          },
        },
        controller.signal,
      );
    } catch (error) {
      throw this.toProviderError(error, token);
    } finally {
      subscription.dispose();
      this.activeRequests.delete(controller);
      this.log.info(
        `Chat finished: model=${model.id} elapsed=${Date.now() - started}ms`,
      );
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(
      estimateTokensFor(text as string | RequestMessageLike),
    );
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  /**
   * Forward upstream token usage to VS Code. The chat UI reads usage from a
   * `LanguageModelDataPart` with mime type "usage" carrying the OpenAI-style
   * usage JSON (prompt_tokens / completion_tokens / ...). This is the same
   * stable-API channel the built-in providers use; without it the UI shows 0.
   *
   * NOTE: the cached-input line cannot be surfaced by a third-party provider.
   * VS Code's only "usage" decoder reads prompt/completion/reasoning tokens
   * and never builds the modelTotals[].cachedTokens the cached line needs;
   * that data flows exclusively through the built-in Copilot metadata channel.
   */
  private reportUsage(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    usage: unknown,
  ): void {
    if (!isRecord(usage)) return;
    const promptTokens = usage.prompt_tokens;
    const completionTokens = usage.completion_tokens;
    if (
      typeof promptTokens !== "number" &&
      typeof completionTokens !== "number"
    ) {
      return;
    }
    try {
      progress.report(
        new vscode.LanguageModelDataPart(
          new TextEncoder().encode(JSON.stringify(usage)),
          "usage",
        ),
      );
    } catch (error) {
      this.log.error("Failed to report usage", error);
    }
  }

  dispose(): void {
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    this.changeEmitter.dispose();
  }

  private promptForSetup(): void {
    const now = Date.now();
    if (now - this.lastSetupPromptAt < 60_000) return;
    this.lastSetupPromptAt = now;

    const signIn = t("Sign In");
    const importPat = t("Import PAT");
    const createGroup = t("Create Provider Group");
    const showLogs = t("Show Logs");
    const actions = [
      ...(this.profile.setup.signIn ? [signIn] : []),
      ...(this.profile.setup.importPat ? [importPat] : []),
      ...(this.profile.setup.createGroup ? [createGroup] : []),
      showLogs,
    ];
    const message = t(
      "Qoder Direct: no models available. Sign in to Qoder first.",
    );

    void vscode.window
      .showWarningMessage(message, ...actions)
      .then((choice) => {
        if (choice === signIn && this.profile.setup.signIn) {
          void vscode.commands.executeCommand(this.profile.setup.signIn);
        } else if (choice === importPat && this.profile.setup.importPat) {
          void vscode.commands.executeCommand(this.profile.setup.importPat);
        } else if (choice === createGroup && this.profile.setup.createGroup) {
          void vscode.commands.executeCommand(this.profile.setup.createGroup);
        } else if (choice === showLogs) {
          void vscode.commands.executeCommand(this.profile.setup.showLogs);
        }
      });
  }

  private async findModel(
    id: string,
    signal?: AbortSignal,
  ): Promise<ProviderModel | undefined> {
    let model = this.store.getModels().find((entry) => entry.id === id);
    if (!model) {
      await this.store.load(false, signal);
      model = this.store.getModels().find((entry) => entry.id === id);
    }
    return model;
  }

  private toProviderError(
    error: unknown,
    token: vscode.CancellationToken,
  ): Error {
    if (token.isCancellationRequested || error instanceof HubCancelledError) {
      return new vscode.CancellationError();
    }
    if (error instanceof HubTimeoutError) {
      return new Error(
        t(
          "Qoder Direct: request timed out after {0} ms.",
          String(error.timeoutMs),
        ),
      );
    }
    if (error instanceof HubError) {
      const message = localizedAuthMessage(error);
      if (error.status === 401) {
        return vscode.LanguageModelError.NoPermissions(message);
      }
      if (error.status === 403) {
        return vscode.LanguageModelError.Blocked(message);
      }
      if (error.status === 404) {
        return vscode.LanguageModelError.NotFound(message);
      }
      return new Error(message, { cause: error });
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

function toolInput(call: ToolCallResult): object {
  return isRecord(call.input) ? call.input : { value: call.input };
}

/**
 * The hub only raises the upstream context limit when X-QD-Context is present.
 * When the runtime does not pass a modelConfiguration choice, fall back to the
 * default advertised in the model's configuration schema.
 */
function defaultContextSize(model: ProviderModel): number | undefined {
  const value = model.configurationSchema?.properties.contextSize?.default;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
