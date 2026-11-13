import { describe, expect, it } from "vitest";
import { endpointsFor } from "../src/direct/endpoints";
import {
  exchangeJobToken,
  fetchQoderUserInfo,
  isSessionDeadMessage,
  pollDeviceLogin,
  refreshDeviceToken,
  refreshJobToken,
  startDeviceLogin,
} from "../src/direct/oauth";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Qoder device OAuth", () => {
  it("builds a CN device authorization URL", () => {
    const { pending, authUrl } = startDeviceLogin(endpointsFor(), {
      machineId: "machine-1",
      now: () => 123,
    });
    expect(pending.verifier.length).toBe(64);
    expect(pending.machineId).toBe("machine-1");
    expect(pending.createdAt).toBe(123);
    const url = new URL(authUrl);
    expect(url.origin).toBe("https://qoder.com.cn");
    expect(url.pathname).toBe("/device/selectAccounts");
    expect(url.searchParams.get("challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe(
      "1c5e33e1-364d-4ce6-b02c-acaa81274a5c",
    );
    expect(url.searchParams.get("redirect_uri")).toBe("qoder-work-cn://");
    expect(url.searchParams.get("machine_id")).toBe("machine-1");
  });

  it("builds VPC login and polling hosts", async () => {
    const endpoints = endpointsFor("acme");
    const { authUrl, pending } = startDeviceLogin(endpoints, {
      machineId: "machine-1",
    });
    expect(authUrl.startsWith("https://acme.vpc.qoder.com.cn/")).toBe(true);

    let requested = "";
    const result = await pollDeviceLogin(endpoints, pending, {
      fetchImpl: async (input) => {
        requested = String(input);
        return jsonResponse({
          token: "dt-access",
          refresh_token: "drt-refresh",
          user_id: "uid",
          expires_in: 1000,
        });
      },
      now: () => 5000,
    });
    expect(requested.startsWith("https://acme-openapi.vpc.qoder.com.cn/")).toBe(
      true,
    );
    expect(result).toMatchObject({
      accessToken: "dt-access",
      refreshToken: "drt-refresh",
      userId: "uid",
      expiresAt: 6000,
    });
  });

  it("treats 202 and 404 as pending", async () => {
    const endpoints = endpointsFor();
    const { pending } = startDeviceLogin(endpoints, { machineId: "m" });
    for (const status of [202, 404]) {
      const result = await pollDeviceLogin(endpoints, pending, {
        fetchImpl: async () => new Response("", { status }),
      });
      expect(result).toBeUndefined();
    }
  });

  it("reads user info", async () => {
    const user = await fetchQoderUserInfo(endpointsFor(), "dt-access", {
      fetchImpl: async (_input, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer dt-access",
        );
        return jsonResponse({
          id: "uid",
          name: "Tester",
          user_type: "personal",
          organization_id: "org",
          organization_name: "Org",
        });
      },
    });
    expect(user).toEqual({
      id: "uid",
      name: "Tester",
      userType: "personal",
      organizationId: "org",
      organizationName: "Org",
    });
  });

  it("refreshes a device token", async () => {
    let body = "";
    const result = await refreshDeviceToken(
      endpointsFor("acme"),
      "drt-old",
      {
        fetchImpl: async (input, init) => {
          expect(String(input)).toBe(
            "https://acme-openapi.vpc.qoder.com.cn/api/v1/deviceToken/refresh",
          );
          body = String(init?.body);
          return jsonResponse({
            token: "dt-new",
            refresh_token: "drt-new",
            user_id: "uid",
            expires_in: 2000,
          });
        },
        now: () => 1000,
      },
    );
    expect(JSON.parse(body)).toEqual({ refresh_token: "drt-old" });
    expect(result).toMatchObject({
      accessToken: "dt-new",
      refreshToken: "drt-new",
      expiresAt: 3000,
    });
  });

  it("maps HTTP errors to HubError", async () => {
    const endpoints = endpointsFor();
    const { pending } = startDeviceLogin(endpoints, { machineId: "m" });
    await expect(
      pollDeviceLogin(endpoints, pending, {
        fetchImpl: async () =>
          jsonResponse({ error: { message: "bad token" } }, 401),
      }),
    ).rejects.toMatchObject({ name: "HubError", status: 401, message: "bad token" });
  });
});

describe("Qoder job tokens (PAT)", () => {
  it("exchanges a PAT on the VPC openapi host with the official UA", async () => {
    let url = "";
    let body = "";
    let headers: Record<string, string> = {};
    const result = await exchangeJobToken(endpointsFor("acme"), "pt-secret", {
      fetchImpl: async (input, init) => {
        url = String(input);
        body = String(init?.body);
        headers = init?.headers as Record<string, string>;
        return jsonResponse({
          token: "jt-access",
          refresh_token: "jrt-refresh",
          expires_in: 3_600_000,
        });
      },
      now: () => 1000,
    });
    expect(url).toBe(
      "https://acme-openapi.vpc.qoder.com.cn/api/v1/jobToken/exchange",
    );
    expect(JSON.parse(body)).toEqual({ personal_token: "pt-secret" });
    expect(headers["User-Agent"]).toBe("QoderWork/1.1.75");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(result).toEqual({
      accessToken: "jt-access",
      refreshToken: "jrt-refresh",
      expiresAt: 3_601_000,
    });
  });

  it("defaults job token expiry to 24h and tolerates a missing refresh_token", async () => {
    const result = await exchangeJobToken(endpointsFor(), "pt-secret", {
      fetchImpl: async () => jsonResponse({ token: "jt-access" }),
      now: () => 1000,
    });
    expect(result).toEqual({
      accessToken: "jt-access",
      refreshToken: "",
      expiresAt: 1000 + 24 * 60 * 60 * 1000,
    });
  });

  it("rejects an exchange response without a token", async () => {
    await expect(
      exchangeJobToken(endpointsFor(), "pt-secret", {
        fetchImpl: async () => jsonResponse({ refresh_token: "jrt-only" }),
      }),
    ).rejects.toMatchObject({ name: "HubError" });
  });

  it("refreshes a job refresh token", async () => {
    let url = "";
    let body = "";
    const result = await refreshJobToken(endpointsFor(), "jrt-old", {
      fetchImpl: async (input, init) => {
        url = String(input);
        body = String(init?.body);
        return jsonResponse({
          token: "jt-new",
          refresh_token: "jrt-new",
          expires_in: 2000,
        });
      },
      now: () => 1000,
    });
    expect(url).toBe("https://openapi.qoder.com.cn/api/v1/jobToken/refresh");
    expect(JSON.parse(body)).toEqual({ refresh_token: "jrt-old" });
    expect(result).toEqual({
      accessToken: "jt-new",
      refreshToken: "jrt-new",
      expiresAt: 3000,
    });
  });

  it("surfaces exchange HTTP errors with the upstream message", async () => {
    await expect(
      exchangeJobToken(endpointsFor(), "pt-revoked", {
        fetchImpl: async () =>
          jsonResponse({ message: "TOKEN_EXPIRE: personal token" }, 401),
      }),
    ).rejects.toMatchObject({
      name: "HubError",
      status: 401,
      message: "TOKEN_EXPIRE: personal token",
    });
  });

  it("detects session-dead markers", () => {
    expect(isSessionDeadMessage("upstream said TOKEN_EXPIRE")).toBe(true);
    expect(isSessionDeadMessage("errno 12153")).toBe(true);
    expect(isSessionDeadMessage("Offline user session not found")).toBe(true);
    expect(isSessionDeadMessage("queued: 10605")).toBe(false);
    expect(isSessionDeadMessage("")).toBe(false);
  });
});
