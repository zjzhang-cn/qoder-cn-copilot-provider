import { beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { activate } from "../src/extension";
import { state } from "./mocks/vscode";

function createContext() {
  const subscriptions: Array<{ dispose(): void }> = [];
  const secrets = new Map<string, string>();
  return {
    subscriptions,
    globalStorageUri: { fsPath: "/tmp/opencode/qoder-direct-test" },
    secrets: {
      async get(key: string): Promise<string | undefined> {
        return secrets.get(key);
      },
      async store(key: string, value: string): Promise<void> {
        secrets.set(key, value);
      },
      async delete(key: string): Promise<void> {
        secrets.delete(key);
      },
      onDidChange() {
        return { dispose: () => undefined };
      },
    },
    globalState: {
      get<T>(): T | undefined {
        return undefined;
      },
      async update(): Promise<void> {
        // no-op
      },
    },
  };
}

describe("activate", () => {
  beforeEach(() => {
    state.vendor = "";
    state.provider = undefined;
    state.providers.clear();
    state.commands.clear();
    state.output.length = 0;
    state.outputShown = false;
    state.executed.length = 0;
    state.commandHandlers.clear();
    state.inputQueue.length = 0;
    state.messages.info.length = 0;
    state.messages.error.length = 0;
    state.messages.warning.length = 0;
  });

  it("registers the direct provider and commands", () => {
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);

    expect(state.providers.has("qoder-direct")).toBe(true);
    expect([...state.commands.keys()]).toEqual([
      "qoderDirect.signIn",
      "qoderDirect.signOut",
      "qoderDirect.refreshModels",
      "qoderDirect.createProviderGroup",
      "qoderDirect.deleteProviderGroup",
      "qoderDirect.showLogs",
    ]);
    expect(context.subscriptions.length).toBeGreaterThan(0);
  });

  it("shows the output channel from the logs command", () => {
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);
    state.commands.get("qoderDirect.showLogs")?.();
    expect(state.outputShown).toBe(true);
  });

  it("createProviderGroup warns before sign-in", async () => {
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);
    await state.commands.get("qoderDirect.createProviderGroup")?.();
    expect(state.messages.warning).toContain("Qoder Direct: sign in first.");
  });

  it("deleteProviderGroup removes the group", async () => {
    state.commandHandlers.set(
      "lm.removeLanguageModelsProviderGroup",
      () => undefined,
    );
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);
    await state.commands.get("qoderDirect.deleteProviderGroup")?.();
    expect(state.executed).toContainEqual({
      command: "lm.removeLanguageModelsProviderGroup",
      args: [{ name: "Qoder Direct", vendor: "qoder-direct" }],
    });
    expect(state.messages.info).toContain(
      "Qoder Direct: provider group deleted.",
    );
  });

  it("signOut clears the session", async () => {
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);
    await state.commands.get("qoderDirect.signOut")?.();
    expect(state.messages.info).toContain("Qoder Direct: signed out.");
  });
});
