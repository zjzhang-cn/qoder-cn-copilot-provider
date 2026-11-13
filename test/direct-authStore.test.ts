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
