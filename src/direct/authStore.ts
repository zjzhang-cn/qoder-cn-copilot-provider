import { join } from "node:path";
import { HubError } from "../backend";
import { endpointsFor } from "./endpoints";
import { withFileLock } from "./lock";
import {
  exchangeJobToken,
  isSessionDeadMessage,
  refreshDeviceToken,
  refreshJobToken,
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
  /** Long-lived `pt-` token; final refresh fallback for PAT sessions. */
  personalToken?: string;
  /** UI-only provenance; refresh routing uses the refreshToken prefix. */
  source?: "oauth" | "pat";
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
    if (!auth.refreshToken && !auth.personalToken) {
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
    if (!auth.refreshToken && !auth.personalToken) {
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
        if (!current.refreshToken && !current.personalToken) {
          throw new HubError("Qoder session expired. Sign in again.", 401);
        }
        if (signal?.aborted) throw new HubError("Qoder token refresh cancelled.");
        const endpoints = endpointsFor(current.instance);
        const deps = {
          fetchImpl: this.options.fetchImpl,
          now: this.now,
          signal,
        };
        let refreshed: {
          accessToken: string;
          refreshToken: string;
          expiresAt: number;
        };
        if (current.refreshToken.startsWith("drt-")) {
          refreshed = await refreshDeviceToken(
            endpoints,
            current.refreshToken,
            deps,
          );
        } else {
          // Job-token family: jrt- first, then the PAT re-exchange fallback.
          // Any failure (network included) falls back, matching the hub.
          try {
            if (!current.refreshToken) {
              throw new HubError("Qoder job refresh token is missing.", 401);
            }
            refreshed = await refreshJobToken(
              endpoints,
              current.refreshToken,
              deps,
            );
          } catch (refreshError) {
            if (!current.personalToken) throw refreshError;
            try {
              refreshed = await exchangeJobToken(
                endpoints,
                current.personalToken,
                deps,
              );
            } catch (exchangeError) {
              throw patExchangeError(exchangeError);
            }
          }
        }
        const next: DirectAuth = {
          ...current,
          accessToken: refreshed.accessToken,
          // A missing job refresh_token must not erase a usable jrt-.
          refreshToken: refreshed.refreshToken || current.refreshToken,
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
    typeof auth.machineId === "string" &&
    (auth.personalToken === undefined ||
      typeof auth.personalToken === "string") &&
    (auth.source === undefined ||
      auth.source === "oauth" ||
      auth.source === "pat")
  );
}

/** A dead PAT surfaces as 401 so the provider maps it to NoPermissions. */
function patExchangeError(error: unknown): HubError {
  if (
    error instanceof HubError &&
    (error.status === 401 || error.status === 403) &&
    isSessionDeadMessage(error.message)
  ) {
    return new HubError(
      "Qoder PAT is invalid or revoked. Import a new PAT.",
      401,
      undefined,
      { cause: error },
    );
  }
  return error instanceof HubError
    ? error
    : new HubError(String(error), undefined, undefined, { cause: error });
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
