import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as vscode from "vscode";
import type { DirectAuth } from "./direct/authStore";
import { DirectAuthManager } from "./direct/authStore";
import { DirectQoderClient } from "./direct/client";
import {
  describeEndpoints,
  endpointsFor,
  normalizeVpcInstance,
} from "./direct/endpoints";
import { DirectLimiter } from "./direct/limiter";
import {
  exchangeJobToken,
  fetchQoderUserInfo,
  pollDeviceLogin,
  startDeviceLogin,
} from "./direct/oauth";
import { ModelStore } from "./core/modelStore";
import { redactTokens } from "./core/util";
import { PENDING_KEY } from "./config";
import { t } from "./l10n";
import { Logger } from "./logger";
import { DIRECT_PROFILE } from "./profiles";
import { QoderProvider } from "./provider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Qoder Direct");
  const logger = new Logger(output);
  const secrets = context.secrets;
  logger.info("Qoder Direct activated.");

  const auth = new DirectAuthManager({
    secrets,
    authKey: DIRECT_PROFILE.secretKey,
    pendingKey: PENDING_KEY,
    lockDir: context.globalStorageUri.fsPath,
  });
  const client = new DirectQoderClient({
    authManager: auth,
    getWorkspacePath: () =>
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
    logger: (message) => logger.info(message),
    limiter: new DirectLimiter({
      gapMs: 300,
      lockPath: join(
        context.globalStorageUri.fsPath,
        "qoder-direct-chat.lock",
      ),
    }),
  });
  const store = new ModelStore({
    client,
    memento: context.globalState,
    cacheKey: DIRECT_PROFILE.cacheKey,
    logger: (message) => logger.info(message),
    getExcludedModels: () => [],
    getModelOverrides: () => ({}),
  });
  const provider = new QoderProvider(
    store,
    client,
    logger,
    DIRECT_PROFILE,
  );

  async function addProviderGroup(authState: DirectAuth): Promise<boolean> {
    try {
      await vscode.commands.executeCommand(
        "lm.addLanguageModelsProviderGroup",
        {
          name: DIRECT_PROFILE.groupName,
          vendor: DIRECT_PROFILE.vendor,
          account: authState.name ?? authState.uid,
          instance: authState.instance ?? "",
        },
      );
      logger.info("Created the Qoder Direct provider group.");
      return true;
    } catch (error) {
      const message = errorMessage(error);
      if (/exist|duplicate/i.test(message)) {
        logger.info("The Qoder Direct provider group already exists.");
        return true;
      }
      logger.error("Failed to create the Qoder Direct provider group", error);
      return false;
    }
  }

  async function promptGateway(): Promise<{ instance?: string } | undefined> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: t("Qoder CN (public)"),
          description: "qoder.com.cn",
          value: "public",
        },
        {
          label: t("Qoder CN VPC"),
          description: t("Enterprise VPC"),
          value: "vpc",
        },
      ],
      {
        title: t("Qoder Direct: choose a gateway"),
        ignoreFocusOut: true,
      },
    );
    if (!choice) return undefined;
    if (choice.value !== "vpc") return {};

    const input = await vscode.window.showInputBox({
      title: t("Qoder Direct: enter the VPC instance name"),
      prompt: t("For example: acme"),
      placeHolder: "acme",
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          normalizeVpcInstance(value);
          return undefined;
        } catch (error) {
          return errorMessage(error);
        }
      },
    });
    if (input === undefined) return undefined;
    const instance = normalizeVpcInstance(input);
    if (!instance) return undefined;
    logger.info(
      `VPC hosts: ${describeEndpoints(endpointsFor(instance)).join(" | ")}`,
    );
    return { instance };
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function signIn(): Promise<void> {
    const gateway = await promptGateway();
    if (!gateway) return;
    const endpoints = endpointsFor(gateway.instance);
    const machineKey = `qoderDirect.machineId.${gateway.instance ?? "public"}`;
    let machineId = context.globalState.get<string>(machineKey);
    if (!machineId) {
      machineId = randomUUID();
      await context.globalState.update(machineKey, machineId);
    }
    const start = startDeviceLogin(endpoints, { machineId });
    await auth.savePending(start.pending);
    logger.info(`Starting sign-in (${gateway.instance ?? "public"}).`);

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t("Qoder Direct: waiting for browser sign-in"),
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({
            message: t("Complete the Qoder sign-in in your browser."),
          });
          const opened = await vscode.env.openExternal(
            vscode.Uri.parse(start.authUrl),
          );
          if (!opened) {
            logger.info(`Open this URL to sign in: ${start.authUrl}`);
          }
          const deadline = Date.now() + 10 * 60 * 1000;
          while (Date.now() < deadline) {
            if (token.isCancellationRequested) {
              throw new vscode.CancellationError();
            }
            const polled = await pollDeviceLogin(endpoints, start.pending);
            if (polled) return polled;
            await delay(2000);
          }
          throw new Error(t("Qoder Direct sign-in timed out."));
        },
      );
      if (!result) return;

      const user = await fetchQoderUserInfo(endpoints, result.accessToken);
      const authState: DirectAuth = {
        version: 1,
        realm: "cn",
        ...(gateway.instance ? { instance: gateway.instance } : {}),
        uid: user.id,
        ...(user.name ? { name: user.name } : {}),
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        machineId,
        ...(user.userType ? { userType: user.userType } : {}),
        ...(user.organizationId
          ? { organizationId: user.organizationId }
          : {}),
        ...(user.organizationName
          ? { organizationName: user.organizationName }
          : {}),
      };
      await auth.saveAuth(authState);
      await auth.clearPending();
      await addProviderGroup(authState);
      store.clear();
      provider.refresh();

      let modelCount: number | undefined;
      try {
        modelCount = (await store.refresh()).length;
      } catch (error) {
        logger.error("Model list failed after sign-in", error);
      }
      void vscode.window.showInformationMessage(
        modelCount === undefined
          ? t(
              "Qoder Direct: signed in. Model list is unavailable; check the logs.",
            )
          : t(
              "Qoder Direct: signed in. {0} models available.",
              String(modelCount),
            ),
      );
    } catch (error) {
      await auth.clearPending();
      if (error instanceof vscode.CancellationError) return;
      logger.error("Sign-in failed", error);
      void vscode.window.showErrorMessage(
        t("Qoder Direct: sign-in failed: {0}", errorMessage(error)),
      );
    }
  }

  async function signOut(): Promise<void> {
    await auth.clearAuth();
    store.clear();
    provider.refresh();
    void vscode.window.showInformationMessage(t("Qoder Direct: signed out."));
  }

  async function importPat(): Promise<void> {
    const gateway = await promptGateway();
    if (!gateway) return;
    const patInput = await vscode.window.showInputBox({
      title: t("Qoder Direct: import a PAT"),
      prompt: t(
        "Create a token in Qoder web: Settings → Personal Access Token, then paste it here.",
      ),
      placeHolder: "pt-...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().startsWith("pt-")
          ? undefined
          : t("A PAT must start with pt-."),
    });
    if (patInput === undefined) return;
    const pat = patInput.trim();
    if (!pat.startsWith("pt-")) return;

    const existing = await auth.getAuth();
    if (existing) {
      const replace = t("Replace");
      const choice = await vscode.window.showWarningMessage(
        t(
          "Qoder Direct: importing this PAT replaces the current sign-in ({0}).",
          existing.uid.slice(0, 8),
        ),
        { modal: true },
        replace,
      );
      if (choice !== replace) return;
    }

    const endpoints = endpointsFor(gateway.instance);
    const machineKey = `qoderDirect.machineId.${gateway.instance ?? "public"}`;
    let machineId = context.globalState.get<string>(machineKey);
    if (!machineId) {
      machineId = randomUUID();
      await context.globalState.update(machineKey, machineId);
    }
    logger.info(
      `Starting PAT import (${gateway.instance ?? "public"}).`,
    );

    try {
      const { authState, modelCount } = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t("Qoder Direct: importing PAT"),
          cancellable: true,
        },
        async (_progress, token) => {
          const controller = new AbortController();
          const onCancel = token.onCancellationRequested(() =>
            controller.abort(),
          );
          try {
            if (token.isCancellationRequested) {
              throw new vscode.CancellationError();
            }
            const exchanged = await exchangeJobToken(endpoints, pat, {
              signal: controller.signal,
            });
            // Identity is mandatory: COSY headers derive from uid.
            const user = await fetchQoderUserInfo(
              endpoints,
              exchanged.accessToken,
              { signal: controller.signal },
            );
            if (token.isCancellationRequested) {
              throw new vscode.CancellationError();
            }
            const next: DirectAuth = {
              version: 1,
              realm: "cn",
              ...(gateway.instance ? { instance: gateway.instance } : {}),
              uid: user.id,
              ...(user.name ? { name: user.name } : {}),
              accessToken: exchanged.accessToken,
              refreshToken: exchanged.refreshToken,
              expiresAt: exchanged.expiresAt,
              machineId,
              personalToken: pat,
              source: "pat",
              ...(user.userType ? { userType: user.userType } : {}),
              ...(user.organizationId
                ? { organizationId: user.organizationId }
                : {}),
              ...(user.organizationName
                ? { organizationName: user.organizationName }
                : {}),
            };
            await auth.saveAuth(next);
            await auth.clearPending();
            await addProviderGroup(next);
            store.clear();
            provider.refresh();
            logger.info(
              `PAT import succeeded (source=pat instance=${gateway.instance ?? "public"}).`,
            );

            let count: number | undefined;
            try {
              count = (await store.refresh()).length;
            } catch (error) {
              logger.error("Model list failed after PAT import", error);
            }
            return { authState: next, modelCount: count };
          } finally {
            onCancel.dispose();
          }
        },
      );

      void vscode.window.showInformationMessage(
        modelCount === undefined
          ? t(
              "Qoder Direct: signed in with PAT ({0}). Model list is unavailable; check the logs.",
              authState.name ?? authState.uid,
            )
          : t(
              "Qoder Direct: signed in with PAT ({0}). {1} models available.",
              authState.name ?? authState.uid,
              String(modelCount),
            ),
      );
    } catch (error) {
      if (error instanceof vscode.CancellationError) return;
      logger.error("PAT import failed", error);
      void vscode.window.showErrorMessage(
        t("Qoder Direct: PAT import failed: {0}", errorMessage(error)),
      );
    }
  }

  async function createGroup(): Promise<void> {
    const authState = await auth.getAuth();
    if (!authState) {
      void vscode.window.showWarningMessage(t("Qoder Direct: sign in first."));
      return;
    }
    const created = await addProviderGroup(authState);
    provider.refresh();
    void vscode.window.showInformationMessage(
      created
        ? t(
            "Qoder Direct: provider group is ready. Use Manage Language Models to edit or delete it.",
          )
        : t("Qoder Direct: could not create the provider group. See the logs."),
    );
  }

  async function deleteGroup(): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        "lm.removeLanguageModelsProviderGroup",
        { name: DIRECT_PROFILE.groupName, vendor: DIRECT_PROFILE.vendor },
      );
      provider.refresh();
      void vscode.window.showInformationMessage(
        t("Qoder Direct: provider group deleted."),
      );
    } catch (error) {
      logger.info(
        `Internal provider group removal is unavailable: ${errorMessage(error)}`,
      );
      void vscode.window.showWarningMessage(
        t(
          "Qoder Direct: delete the Qoder Direct group from Manage Language Models.",
        ),
      );
    }
  }

  async function refreshModels(): Promise<void> {
    try {
      store.clear();
      const models = await store.refresh();
      provider.refresh();
      void vscode.window.showInformationMessage(
        t(
          "Qoder Direct: model list refreshed. {0} models available.",
          String(models.length),
        ),
      );
    } catch (error) {
      logger.error("Model refresh failed", error);
      void vscode.window.showErrorMessage(
        t("Qoder Direct: model list failed: {0}", errorMessage(error)),
      );
    }
  }

  const commands = [
    vscode.commands.registerCommand("qoderDirect.signIn", async () => {
      await signIn();
    }),
    vscode.commands.registerCommand("qoderDirect.importPat", async () => {
      await importPat();
    }),
    vscode.commands.registerCommand("qoderDirect.signOut", async () => {
      await signOut();
    }),
    vscode.commands.registerCommand("qoderDirect.refreshModels", async () => {
      await refreshModels();
    }),
    vscode.commands.registerCommand(
      "qoderDirect.createProviderGroup",
      async () => {
        await createGroup();
      },
    ),
    vscode.commands.registerCommand(
      "qoderDirect.deleteProviderGroup",
      async () => {
        await deleteGroup();
      },
    ),
    vscode.commands.registerCommand("qoderDirect.showLogs", () => {
      logger.show();
    }),
  ];

  const secretListener = secrets.onDidChange((event) => {
    if (event.key !== DIRECT_PROFILE.secretKey) return;
    store.clear();
    provider.refresh();
  });

  context.subscriptions.push(
    output,
    provider,
    vscode.lm.registerLanguageModelChatProvider(
      DIRECT_PROFILE.vendor,
      provider,
    ),
    ...commands,
    secretListener,
  );
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactTokens(message);
}
