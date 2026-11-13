import { join } from "node:path";
import { HubError } from "../backend";
import { endpointsFor } from "./endpoints";
import { withFileLock } from "./lock";
import {
  refreshDeviceToken,
  type PendingLogin,
} from "./oauth";

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface DirectAuth {
  version: 1;
  realm: "cn";
  instance?: string;
  uid: string;
  name?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userType?: string;
  organizationId?: string;
  organizationName?: string;
  machineId: string;
}

export interface DirectAuthManagerOptions {
  secrets: SecretStorageLike;
  authKey: string;
  pendingKey: string;
  lockDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class DirectAuthManager {
  private refreshing: Promise<DirectAuth> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: DirectAuthManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  async getAuth(): Promise<DirectAuth | undefined> {
    const raw = await this.options.secrets.get(this.options.authKey);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isDirectAuth(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async saveAuth(auth: DirectAuth): Promise<void> {
    await this.options.secrets.store(this.options.authKey, JSON.stringify(auth));
  }

  async clearAuth(): Promise<void> {
    await this.options.secrets.delete(this.options.authKey);
    await this.options.secrets.delete(this.options.pendingKey);
  }

  async getPending(): Promise<PendingLogin | undefined> {
    const raw = await this.options.secrets.get(this.options.pendingKey);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isPendingLogin(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async savePending(pending: PendingLogin): Promise<void> {
    await this.options.secrets.store(
      this.options.pendingKey,
      JSON.stringify(pending),
    );
  }

  async clearPending(): Promise<void> {
    await this.options.secrets.delete(this.options.pendingKey);
  }

  async ensureFresh(auth: DirectAuth, signal?: AbortSignal): Promise<DirectAuth> {
    if (auth.expiresAt - this.now() > REFRESH_MARGIN_MS) return auth;
    if (!auth.refreshToken) {
      throw new HubError("Qoder session expired. Sign in again.", 401);
    }
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshWithLock(auth, signal, false).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async forceRefresh(
    auth: DirectAuth,
    signal?: AbortSignal,
  ): Promise<DirectAuth> {
    if (!auth.refreshToken) {
      throw new HubError("Qoder session expired. Sign in again.", 401);
    }
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshWithLock(auth, signal, true).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshWithLock(
    auth: DirectAuth,
    signal: AbortSignal | undefined,
    force: boolean,
  ): Promise<DirectAuth> {
    const lockPath = join(this.options.lockDir, "qoder-direct-auth.lock");
    return withFileLock(
      lockPath,
      { timeoutMs: 30_000, ttlMs: 60_000 },
      async () => {
        const stored = await this.getAuth();
        const current =
          stored && stored.uid === auth.uid ? stored : auth;
        if (!force && current.expiresAt - this.now() > REFRESH_MARGIN_MS) {
          return current;
        }
        if (!current.refreshToken) {
          throw new HubError("Qoder session expired. Sign in again.", 401);
        }
        if (signal?.aborted) throw new HubError("Qoder token refresh cancelled.");
        const endpoints = endpointsFor(current.instance);
        const refreshed = await refreshDeviceToken(
          endpoints,
          current.refreshToken,
          { fetchImpl: this.options.fetchImpl, now: this.now },
        );
        const next: DirectAuth = {
          ...current,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        };
        await this.saveAuth(next);
        return next;
      },
    );
  }
}

function isDirectAuth(value: unknown): value is DirectAuth {
  if (typeof value !== "object" || value === null) return false;
  const auth = value as Record<string, unknown>;
  return (
    auth.version === 1 &&
    auth.realm === "cn" &&
    typeof auth.uid === "string" &&
    typeof auth.accessToken === "string" &&
    typeof auth.refreshToken === "string" &&
    typeof auth.expiresAt === "number" &&
    typeof auth.machineId === "string"
  );
}

function isPendingLogin(value: unknown): value is PendingLogin {
  if (typeof value !== "object" || value === null) return false;
  const pending = value as Record<string, unknown>;
  return (
    typeof pending.verifier === "string" &&
    typeof pending.nonce === "string" &&
    typeof pending.machineId === "string" &&
    typeof pending.createdAt === "number"
  );
}
