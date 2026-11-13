import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { activate } from "../src/extension";
import { state } from "./mocks/vscode";

function createContext() {
  const subscriptions: Array<{ dispose(): void }> = [];
  const secrets = new Map<string, string>();
  const globalState = new Map<string, unknown>();
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
      get<T>(key: string): T | undefined {
        return globalState.get(key) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        globalState.set(key, value);
      },
    },
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes the PAT exchange and userinfo fetches by URL. */
function stubPatFetch(options: { userinfoStatus?: number } = {}): void {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    state.fetchCalls.push({ url });
    if (url.includes("/api/v1/jobToken/exchange")) {
      return jsonResponse({
        token: "jt-access",
        refresh_token: "jrt-refresh",
        expires_in: 86_400_000,
      });
    }
    if (url.includes("/api/v1/userinfo")) {
      if (options.userinfoStatus) {
        return jsonResponse({ message: "no identity" }, options.userinfoStatus);
      }
      return jsonResponse({ id: "uid-pat", name: "PAT Tester" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
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
    state.quickPickQueue.length = 0;
    state.warningQueue.length = 0;
    state.fetchCalls.length = 0;
    state.cancelProgress = false;
    state.warningChoice = undefined;
    state.warningActions.length = 0;
    state.messages.info.length = 0;
    state.messages.error.length = 0;
    state.messages.warning.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the direct provider and commands", () => {
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);

    expect(state.providers.has("qoder-direct")).toBe(true);
    expect([...state.commands.keys()]).toEqual([
      "qoderDirect.signIn",
      "qoderDirect.importPat",
      "qoderDirect.signOut",
      "qoderDirect.refreshModels",
      "qoderDirect.createProviderGroup",
      "qoderDirect.deleteProviderGroup",
      "qoderDirect.showLogs",
      "qoderDirect.showQuota",
      "qoderDirect.refreshQuota",
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

describe("importPat", () => {
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
    state.quickPickQueue.length = 0;
    state.warningQueue.length = 0;
    state.fetchCalls.length = 0;
    state.cancelProgress = false;
    state.warningChoice = undefined;
    state.warningActions.length = 0;
    state.messages.info.length = 0;
    state.messages.error.length = 0;
    state.messages.warning.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("imports a PAT, saves the session, and creates the group", async () => {
    stubPatFetch();
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);
    state.quickPickQueue.push({ value: "public" });
    state.inputQueue.push("  pt-secret  ");

    await state.commands.get("qoderDirect.importPat")?.();

    const exchange = state.fetchCalls.find((call) =>
      call.url.includes("/api/v1/jobToken/exchange"),
    );
    expect(exchange?.url).toBe(
      "https://openapi.qoder.com.cn/api/v1/jobToken/exchange",
    );
    const stored = JSON.parse(
      (await context.secrets.get("qoder-direct.auth.v1")) ?? "{}",
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      uid: "uid-pat",
      name: "PAT Tester",
      accessToken: "jt-access",
      refreshToken: "jrt-refresh",
      personalToken: "pt-secret",
      source: "pat",
    });
    expect(state.executed).toContainEqual({
      command: "lm.addLanguageModelsProviderGroup",
      args: [
        {
          name: "Qoder Direct",
          vendor: "qoder-direct",
          account: "PAT Tester",
          instance: "",
        },
      ],
    });
    // The signed model list goes through node:https (never global fetch), so
    // it is unavailable in this mock environment; the import must still
    // succeed and degrade gracefully.
    expect(state.messages.info).toContain(
      "Qoder Direct: signed in with PAT (PAT Tester). Model list is unavailable; check the logs.",
    );
    // The PAT itself must never reach the output channel.
    expect(state.output.join("\n")).not.toContain("pt-secret");
  });

  it("rejects a PAT without the pt- prefix before any request", async () => {
    stubPatFetch();
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);
    state.quickPickQueue.push({ value: "public" });
    state.inputQueue.push("not-a-pat");

    await state.commands.get("qoderDirect.importPat")?.();

    expect(state.fetchCalls).toHaveLength(0);
    expect(await context.secrets.get("qoder-direct.auth.v1")).toBeUndefined();
  });

  it("does not save anything when userinfo fails", async () => {
    stubPatFetch({ userinfoStatus: 500 });
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);
    state.quickPickQueue.push({ value: "public" });
    state.inputQueue.push("pt-secret");

    await state.commands.get("qoderDirect.importPat")?.();

    expect(await context.secrets.get("qoder-direct.auth.v1")).toBeUndefined();
    expect(state.messages.error.join("\n")).toContain("PAT import failed");
  });

  it("stays silent when cancelled during the in-flight exchange", async () => {
    // The exchange never resolves until aborted, mimicking a slow request
    // that the user cancels from the progress notification.
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      state.fetchCalls.push({ url: String(_input) });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    });
    const context = createContext();
    activate(context as unknown as vscode.ExtensionContext);
    state.quickPickQueue.push({ value: "public" });
    state.inputQueue.push("pt-secret");
    state.cancelProgress = true;

    await state.commands.get("qoderDirect.importPat")?.();

    expect(await context.secrets.get("qoder-direct.auth.v1")).toBeUndefined();
    expect(state.messages.error).toHaveLength(0);
    expect(state.messages.info).toHaveLength(0);
  });

  it("asks before replacing an existing sign-in and honors cancel", async () => {
    stubPatFetch();
    const context = createContext();
    await context.secrets.store(
      "qoder-direct.auth.v1",
      JSON.stringify({
        version: 1,
        realm: "cn",
        uid: "uid-old-12345",
        accessToken: "dt-old",
        refreshToken: "drt-old",
        expiresAt: 9_999_999_999_999,
        machineId: "machine",
      }),
    );
    activate(context as unknown as vscode.ExtensionContext);
    state.quickPickQueue.push({ value: "public" });
    state.inputQueue.push("pt-secret");
    state.warningQueue.push(undefined); // user cancels the modal

    await state.commands.get("qoderDirect.importPat")?.();

    expect(state.messages.warning.join("\n")).toContain("uid-old-");
    // No PAT exchange/userinfo calls (activation may refresh quota separately).
    expect(
      state.fetchCalls.filter(
        (call) =>
          call.url.includes("/jobToken/") || call.url.includes("/userinfo"),
      ),
    ).toHaveLength(0);
    const stored = JSON.parse(
      (await context.secrets.get("qoder-direct.auth.v1")) ?? "{}",
    ) as Record<string, unknown>;
    expect(stored.uid).toBe("uid-old-12345");
  });
});
