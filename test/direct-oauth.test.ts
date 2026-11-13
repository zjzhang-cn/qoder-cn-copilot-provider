import { describe, expect, it } from "vitest";
import { endpointsFor } from "../src/direct/endpoints";
import {
  fetchQoderUserInfo,
  pollDeviceLogin,
  refreshDeviceToken,
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
