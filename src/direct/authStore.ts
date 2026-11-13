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
const LOCK_OPTIONS = { timeoutMs: 30_000, ttlMs: 60_000 };

export class DirectAuthManager {
  private refreshing: Promise<DirectAuth> | undefined;
  private refreshForced = false;
  private readonly now: () => number;

  constructor(private readonly options: DirectAuthManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  private get lockPath(): string {
    return join(this.options.lockDir, "qoder-direct-auth.lock");
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

  /** Raw write; callers must already hold the auth lock. */
  private async writeAuth(auth: DirectAuth): Promise<void> {
    await this.options.secrets.store(this.options.authKey, JSON.stringify(auth));
  }

  async saveAuth(auth: DirectAuth): Promise<void> {
    await withFileLock(this.lockPath, LOCK_OPTIONS, () => this.writeAuth(auth));
  }

  async clearAuth(): Promise<void> {
    await withFileLock(this.lockPath, LOCK_OPTIONS, async () => {
      await this.options.secrets.delete(this.options.authKey);
      await this.options.secrets.delete(this.options.pendingKey);
    });
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
      throw withCode(new HubError("Qoder session expired. Sign in again.", 401), "session-expired");
    }
    if (signal?.aborted) throw withCode(new HubError("Qoder token refresh cancelled."), "refresh-cancelled");
    return this.runRefresh(auth, false);
  }

  async forceRefresh(
    auth: DirectAuth,
    signal?: AbortSignal,
  ): Promise<DirectAuth> {
    if (!auth.refreshToken && !auth.personalToken) {
      throw withCode(new HubError("Qoder session expired. Sign in again.", 401), "session-expired");
    }
    if (signal?.aborted) throw withCode(new HubError("Qoder token refresh cancelled."), "refresh-cancelled");
    // A non-forced refresh in flight may return a locally-fresh but
    // server-revoked token; chain a forced refresh after it instead of
    // piggybacking on its result.
    if (this.refreshing && !this.refreshForced) {
      const prior = this.refreshing;
      const chained = prior
        .catch(() => undefined)
        .then(() => this.startRefresh(auth, true));
      this.refreshing = chained;
      this.refreshForced = true;
      chained.finally(() => {
        if (this.refreshing === chained) {
          this.refreshing = undefined;
          this.refreshForced = false;
        }
      });
      return chained;
    }
    return this.runRefresh(auth, true);
  }

  /**
   * Shared single-flight refresh. The refresh is a shared resource: it is NOT
   * bound to any one caller's abort signal, so cancelling one request cannot
   * abort another request's in-flight refresh. Callers handle their own
   * cancellation at the request layer.
   */
  private runRefresh(auth: DirectAuth, force: boolean): Promise<DirectAuth> {
    if (this.refreshing) return this.refreshing;
    return this.startRefresh(auth, force);
  }

  private startRefresh(auth: DirectAuth, force: boolean): Promise<DirectAuth> {
    const promise = this.refreshWithLock(auth, force).finally(() => {
      if (this.refreshing === promise) {
        this.refreshing = undefined;
        this.refreshForced = false;
      }
    });
    this.refreshing = promise;
    this.refreshForced = force;
    return promise;
  }

  private async refreshWithLock(
    auth: DirectAuth,
    force: boolean,
  ): Promise<DirectAuth> {
    return withFileLock(this.lockPath, LOCK_OPTIONS, async () => {
      const stored = await this.getAuth();
      // The account may have been replaced (import/sign-in) or signed out
      // while this refresh was pending. Never resurrect or overwrite it with
      // a stale snapshot: bail instead of falling back to the passed auth.
      if (!stored || stored.uid !== auth.uid) {
        throw withCode(new HubError("Qoder session changed. Sign in again.", 401), "session-changed");
      }
      const current = stored;
      if (!force && current.expiresAt - this.now() > REFRESH_MARGIN_MS) {
        return current;
      }
      if (!current.refreshToken && !current.personalToken) {
        throw withCode(new HubError("Qoder session expired. Sign in again.", 401), "session-expired");
      }
      const endpoints = endpointsFor(current.instance);
      const deps = {
        fetchImpl: this.options.fetchImpl,
        now: this.now,
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
              throw withCode(new HubError("Qoder job refresh token is missing.", 401), "job-refresh-missing");
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
        await this.writeAuth(next);
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
    return withCode(
      new HubError(
        "Qoder PAT is invalid or revoked. Import a new PAT.",
        401,
        undefined,
        { cause: error },
      ),
      "pat-revoked",
    );
  }
  if (error instanceof HubError) return error;
  // Node fetch failures (DNS/refused/timeout) carry no HTTP status; surface
  // them as an actionable network error rather than raw "fetch failed".
  if (isNetworkError(error)) {
    return withCode(
      new HubError(
        "Cannot reach the Qoder server. Check your network or VPC instance.",
        undefined,
        undefined,
        { cause: error },
      ),
      "network-unreachable",
    );
  }
  return new HubError(String(error), undefined, undefined, { cause: error });
}

function withCode(error: HubError, code: string): HubError {
  error.code = code;
  return error;
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }
  return /fetch failed|network|socket|getaddrinfo/i.test(error.message);
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
