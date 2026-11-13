import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DirectAuthManager,
  type DirectAuth,
  type SecretStorageLike,
} from "../src/direct/authStore";

class FakeSecrets implements SecretStorageLike {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const AUTH_KEY = "qoder-direct.auth.v1";
const PENDING_KEY = "qoder-direct.login.v1";
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qoder-direct-auth-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function auth(overrides: Partial<DirectAuth> = {}): DirectAuth {
  return {
    version: 1,
    realm: "cn",
    instance: "acme",
    uid: "uid",
    accessToken: "dt-old",
    refreshToken: "drt-old",
    expiresAt: 0,
    machineId: "machine",
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("DirectAuthManager", () => {
  it("refreshes once across two managers and persists the new token", async () => {
    const secrets = new FakeSecrets();
    const dir = await tempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({
        token: "dt-new",
        refresh_token: "drt-new",
        user_id: "uid",
        expires_in: 3_600_000,
      });
    };
    const options = {
      secrets,
      authKey: AUTH_KEY,
      pendingKey: PENDING_KEY,
      lockDir: dir,
      fetchImpl,
      now: () => 1000,
    };
    const first = new DirectAuthManager(options);
    const second = new DirectAuthManager(options);
    const original = auth();
    await first.saveAuth(original);

    const [left, right] = await Promise.all([
      first.ensureFresh(original),
      second.ensureFresh(original),
    ]);

    expect(calls).toBe(1);
    expect(left.accessToken).toBe("dt-new");
    expect(right.accessToken).toBe("dt-new");
    expect(left.expiresAt).toBe(3_601_000);
    const stored = await first.getAuth();
    expect(stored).toMatchObject({
      uid: "uid",
      accessToken: "dt-new",
      refreshToken: "drt-new",
      expiresAt: 3_601_000,
      instance: "acme",
    });
  });

  it("does not refresh a fresh token", async () => {
    const secrets = new FakeSecrets();
    const dir = await tempDir();
    let calls = 0;
    const manager = new DirectAuthManager({
      secrets,
      authKey: AUTH_KEY,
      pendingKey: PENDING_KEY,
      lockDir: dir,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
      now: () => 1000,
    });
    const fresh = auth({ expiresAt: 3_600_000 });
    const result = await manager.ensureFresh(fresh);
    expect(result).toBe(fresh);
    expect(calls).toBe(0);
  });

  it("requires a refresh token when expired", async () => {
    const secrets = new FakeSecrets();
    const dir = await tempDir();
    const manager = new DirectAuthManager({
      secrets,
      authKey: AUTH_KEY,
      pendingKey: PENDING_KEY,
      lockDir: dir,
    });
    await expect(
      manager.ensureFresh(auth({ refreshToken: "" })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("stores and clears auth and pending login state", async () => {
    const secrets = new FakeSecrets();
    const dir = await tempDir();
    const manager = new DirectAuthManager({
      secrets,
      authKey: AUTH_KEY,
      pendingKey: PENDING_KEY,
      lockDir: dir,
    });
    await manager.saveAuth(auth({ expiresAt: 123 }));
    expect(await manager.getAuth()).toMatchObject({ uid: "uid", expiresAt: 123 });

    await manager.savePending({
      instance: "acme",
      verifier: "v",
      nonce: "n",
      machineId: "m",
      createdAt: 1,
    });
    expect(await manager.getPending()).toMatchObject({ verifier: "v" });

    await manager.clearAuth();
    expect(await manager.getAuth()).toBeUndefined();
    expect(await manager.getPending()).toBeUndefined();
  });
});

describe("DirectAuthManager PAT sessions", () => {
  function patAuth(overrides: Partial<DirectAuth> = {}): DirectAuth {
    return auth({
      accessToken: "jt-old",
      refreshToken: "jrt-old",
      personalToken: "pt-secret",
      source: "pat",
      ...overrides,
    });
  }

  function managerWith(
    fetchImpl: typeof fetch,
    dir: string,
    secrets = new FakeSecrets(),
  ): DirectAuthManager {
    return new DirectAuthManager({
      secrets,
      authKey: AUTH_KEY,
      pendingKey: PENDING_KEY,
      lockDir: dir,
      fetchImpl,
      now: () => 1000,
    });
  }

  /** Refresh requires a persisted record; seed it before exercising paths. */
  async function seededManager(
    fetchImpl: typeof fetch,
    dir: string,
    record: DirectAuth = patAuth(),
    secrets = new FakeSecrets(),
  ): Promise<DirectAuthManager> {
    const manager = managerWith(fetchImpl, dir, secrets);
    await manager.saveAuth(record);
    return manager;
  }

  it("routes jrt- refresh tokens to the jobToken endpoint", async () => {
    const dir = await tempDir();
    const urls: string[] = [];
    const manager = await seededManager(async (input) => {
      urls.push(String(input));
      return jsonResponse({
        token: "jt-new",
        refresh_token: "jrt-new",
        expires_in: 3_600_000,
      });
    }, dir);
    const result = await manager.ensureFresh(patAuth());
    expect(urls).toEqual([
      "https://acme-openapi.vpc.qoder.com.cn/api/v1/jobToken/refresh",
    ]);
    expect(result.accessToken).toBe("jt-new");
    expect(result.personalToken).toBe("pt-secret");
    expect(result.source).toBe("pat");
  });

  it("falls back to PAT re-exchange when job refresh fails", async () => {
    const dir = await tempDir();
    const urls: string[] = [];
    const manager = await seededManager(async (input) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return jsonResponse({ message: "jrt expired" }, 401);
      }
      return jsonResponse({
        token: "jt-fresh",
        refresh_token: "jrt-fresh",
        expires_in: 3_600_000,
      });
    }, dir);
    const result = await manager.ensureFresh(patAuth());
    expect(urls).toEqual([
      "https://acme-openapi.vpc.qoder.com.cn/api/v1/jobToken/refresh",
      "https://acme-openapi.vpc.qoder.com.cn/api/v1/jobToken/exchange",
    ]);
    expect(result.accessToken).toBe("jt-fresh");
    expect(result.expiresAt).toBe(3_601_000);
  });

  it("falls back to PAT re-exchange on network errors too", async () => {
    const dir = await tempDir();
    let calls = 0;
    const manager = await seededManager(async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return jsonResponse({ token: "jt-fresh", expires_in: 1000 });
    }, dir);
    const result = await manager.ensureFresh(patAuth());
    expect(calls).toBe(2);
    expect(result.accessToken).toBe("jt-fresh");
    // A missing job refresh_token must not erase the stored jrt-.
    expect(result.refreshToken).toBe("jrt-old");
  });

  it("exchanges directly when the PAT record has no jrt-", async () => {
    const dir = await tempDir();
    const urls: string[] = [];
    const record = patAuth({ refreshToken: "" });
    const manager = await seededManager(async (input) => {
      urls.push(String(input));
      return jsonResponse({ token: "jt-fresh", expires_in: 1000 });
    }, dir, record);
    const result = await manager.ensureFresh(record);
    expect(urls).toEqual([
      "https://acme-openapi.vpc.qoder.com.cn/api/v1/jobToken/exchange",
    ]);
    expect(result.accessToken).toBe("jt-fresh");
  });

  it("maps a dead PAT to a 401 re-import error", async () => {
    const dir = await tempDir();
    const secrets = new FakeSecrets();
    const manager = managerWith(
      async () => jsonResponse({ message: "TOKEN_EXPIRE" }, 401),
      dir,
      secrets,
    );
    await manager.saveAuth(patAuth());
    await expect(manager.ensureFresh(patAuth())).rejects.toMatchObject({
      name: "HubError",
      status: 401,
      message: "Qoder PAT is invalid or revoked. Import a new PAT.",
    });
    // The stored credentials are left intact for the user to decide.
    expect(await manager.getAuth()).toMatchObject({
      personalToken: "pt-secret",
      accessToken: "jt-old",
    });
  });

  it("keeps device records on the device endpoint even with a PAT present", async () => {
    const dir = await tempDir();
    const urls: string[] = [];
    const record = auth({ personalToken: "pt-secret", source: "pat" });
    const manager = await seededManager(async (input) => {
      urls.push(String(input));
      return jsonResponse({
        token: "dt-new",
        refresh_token: "drt-new",
        user_id: "uid",
        expires_in: 1000,
      });
    }, dir, record);
    const result = await manager.ensureFresh(record);
    expect(urls).toEqual([
      "https://acme-openapi.vpc.qoder.com.cn/api/v1/deviceToken/refresh",
    ]);
    expect(result.accessToken).toBe("dt-new");
  });

  it("round-trips PAT fields and still accepts legacy records", async () => {
    const dir = await tempDir();
    const secrets = new FakeSecrets();
    const manager = managerWith(async () => jsonResponse({}), dir, secrets);
    await manager.saveAuth(patAuth());
    expect(await manager.getAuth()).toMatchObject({
      personalToken: "pt-secret",
      source: "pat",
    });
    await manager.saveAuth(auth());
    const legacy = await manager.getAuth();
    expect(legacy).toMatchObject({ uid: "uid" });
    expect(legacy?.personalToken).toBeUndefined();
  });
});

describe("DirectAuthManager concurrency", () => {
  function patAuth(overrides: Partial<DirectAuth> = {}): DirectAuth {
    return auth({
      accessToken: "jt-old",
      refreshToken: "jrt-old",
      personalToken: "pt-secret",
      source: "pat",
      ...overrides,
    });
  }

  function managerWith(
    fetchImpl: typeof fetch,
    dir: string,
    secrets = new FakeSecrets(),
  ): DirectAuthManager {
    return new DirectAuthManager({
      secrets,
      authKey: AUTH_KEY,
      pendingKey: PENDING_KEY,
      lockDir: dir,
      fetchImpl,
      now: () => 1000,
    });
  }

  it("sign-out queued behind a refresh wins (no resurrection)", async () => {
    const dir = await tempDir();
    const secrets = new FakeSecrets();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const manager = managerWith(async () => {
      started();
      await gate;
      return jsonResponse({ token: "jt-new", expires_in: 3_600_000 });
    }, dir, secrets);
    await manager.saveAuth(patAuth());

    const refreshing = manager.ensureFresh(patAuth());
    await inFlight;
    // Sign-out waits for the auth lock the refresh holds; it must run after
    // the refresh writes, so the final state is signed-out, not resurrected.
    const cleared = manager.clearAuth();
    release();
    await refreshing;
    await cleared;
    expect(await manager.getAuth()).toBeUndefined();
  });

  it("an import queued behind an old-account refresh wins (no clobber)", async () => {
    const dir = await tempDir();
    const secrets = new FakeSecrets();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const manager = managerWith(async () => {
      started();
      await gate;
      return jsonResponse({ token: "jt-old-account", expires_in: 3_600_000 });
    }, dir, secrets);
    const oldRecord = patAuth();
    await manager.saveAuth(oldRecord);

    const refreshing = manager.ensureFresh(oldRecord);
    await inFlight;
    // The import waits for the lock; it writes after the old refresh, so the
    // freshly imported account is the final state, not the old one.
    const imported = patAuth({ uid: "uid-new", personalToken: "pt-new" });
    const importing = manager.saveAuth(imported);
    release();
    await refreshing;
    await importing;
    expect(await manager.getAuth()).toMatchObject({
      uid: "uid-new",
      personalToken: "pt-new",
    });
  });

  it("bails when the stored account changed before the refresh acquired the lock", async () => {
    const dir = await tempDir();
    const secrets = new FakeSecrets();
    let calls = 0;
    const manager = managerWith(async () => {
      calls += 1;
      return jsonResponse({ token: "jt-new", expires_in: 3_600_000 });
    }, dir, secrets);
    // Storage holds a DIFFERENT account than the snapshot being refreshed.
    await manager.saveAuth(patAuth({ uid: "uid-other" }));
    await expect(manager.ensureFresh(patAuth())).rejects.toMatchObject({
      status: 401,
    });
    // No network call and no write: the other account is untouched.
    expect(calls).toBe(0);
    expect(await manager.getAuth()).toMatchObject({ uid: "uid-other" });
  });

  it("shares one refresh across callers without binding a caller signal", async () => {
    const dir = await tempDir();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const manager = managerWith(async () => {
      calls += 1;
      started();
      await gate;
      return jsonResponse({
        token: "jt-new",
        refresh_token: "jrt-new",
        expires_in: 3_600_000,
      });
    }, dir);
    await manager.saveAuth(patAuth());

    const controllerA = new AbortController();
    const first = manager.ensureFresh(patAuth(), controllerA.signal);
    await inFlight;
    const second = manager.ensureFresh(patAuth());
    // Cancelling caller A must not abort the shared refresh serving B.
    controllerA.abort();
    release();

    const [left, right] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(left.accessToken).toBe("jt-new");
    expect(right.accessToken).toBe("jt-new");
  });

  it("forceRefresh chains a forced refresh after a non-forced one", async () => {
    const dir = await tempDir();
    const urls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const manager = managerWith(async (input) => {
      urls.push(String(input));
      if (urls.length === 1) {
        started();
        await gate;
        // Non-forced refresh returns a locally-fresh token.
        return jsonResponse({
          token: "jt-stale",
          refresh_token: "jrt-stale",
          expires_in: 3_600_000,
        });
      }
      return jsonResponse({
        token: "jt-forced",
        refresh_token: "jrt-forced",
        expires_in: 3_600_000,
      });
    }, dir);
    await manager.saveAuth(patAuth());

    const nonForced = manager.ensureFresh(patAuth());
    await inFlight;
    const forced = manager.forceRefresh(patAuth());
    release();

    const forcedResult = await forced;
    await nonForced;
    // The forced refresh must actually hit the network, not piggyback.
    expect(urls).toHaveLength(2);
    expect(forcedResult.accessToken).toBe("jt-forced");
  });
});
