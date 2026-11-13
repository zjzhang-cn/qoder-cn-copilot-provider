import { describe, expect, it } from "vitest";
import type { DirectAuth, DirectAuthManager } from "../src/direct/authStore";
import { QuotaStatusBar } from "../src/quotaStatusBar";
import type { Logger } from "../src/logger";
import * as vscode from "./mocks/vscode";

const AUTH: DirectAuth = {
  version: 1,
  realm: "cn",
  uid: "uid",
  accessToken: "jt-access",
  refreshToken: "jrt-refresh",
  expiresAt: 9_999_999_999_999,
  machineId: "machine",
};

function authManager(auth: DirectAuth | undefined): DirectAuthManager {
  return {
    getAuth: async () => auth,
    ensureFresh: async (value: DirectAuth) => value,
  } as unknown as DirectAuthManager;
}

const logger = {
  info: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function quotaResponse(): Response {
  return new Response(
    JSON.stringify({
      userQuota: { remaining: 1234, used: 100, total: 1334 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("QuotaStatusBar", () => {
  it("shows the remaining credits after refresh", async () => {
    const bar = new QuotaStatusBar({
      auth: authManager(AUTH),
      logger,
      fetchImpl: async () => quotaResponse(),
    });
    bar.show();
    await bar.refresh();
    const item = vscode.statusBarItems.at(-1);
    expect(item?.shown).toBe(true);
    expect(item?.text).toContain("1,234");
    expect(item?.command).toBe("qoderDirect.showQuota");
    bar.dispose();
  });

  it("hides when signed out", async () => {
    const bar = new QuotaStatusBar({
      auth: authManager(undefined),
      logger,
      fetchImpl: async () => quotaResponse(),
    });
    bar.show();
    await bar.refresh();
    expect(vscode.statusBarItems.at(-1)?.shown).toBe(false);
    bar.dispose();
  });

  it("degrades to unavailable on fetch failure", async () => {
    const bar = new QuotaStatusBar({
      auth: authManager(AUTH),
      logger,
      fetchImpl: async () => new Response("denied", { status: 403 }),
    });
    bar.show();
    await bar.refresh();
    const item = vscode.statusBarItems.at(-1);
    expect(item?.shown).toBe(true);
    expect(item?.text).toContain("unavailable");
    bar.dispose();
  });

  it("shares one request across concurrent refreshes", async () => {
    let calls = 0;
    const bar = new QuotaStatusBar({
      auth: authManager(AUTH),
      logger,
      fetchImpl: async () => {
        calls += 1;
        return quotaResponse();
      },
    });
    await Promise.all([bar.refresh(), bar.refresh(), bar.refresh()]);
    expect(calls).toBe(1);
    bar.dispose();
  });
});