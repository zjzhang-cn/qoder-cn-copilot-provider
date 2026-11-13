import { describe, expect, it } from "vitest";
import { endpointsFor } from "../src/direct/endpoints";
import { fetchQoderQuota } from "../src/direct/quota";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchQoderQuota", () => {
  it("aggregates base + add-on quota with the bearer token", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    const quota = await fetchQoderQuota(endpointsFor("acme"), "jt-access", {
      fetchImpl: async (input, init) => {
        url = String(input);
        headers = init?.headers as Record<string, string>;
        return jsonResponse({
          userQuota: { remaining: 1000, used: 500, total: 1500 },
          addOnQuota: { remaining: 200, used: 0, total: 200 },
        });
      },
    });
    expect(url).toBe(
      "https://acme-openapi.vpc.qoder.com.cn/api/v2/quota/usage",
    );
    expect(headers.Authorization).toBe("Bearer jt-access");
    expect(headers["User-Agent"]).toBe("QoderWork/1.1.75");
    expect(quota).toMatchObject({ remaining: 1200, used: 500, total: 1700 });
  });

  it("includes an available org shared pool using cap", async () => {
    const quota = await fetchQoderQuota(endpointsFor(), "jt", {
      fetchImpl: async () =>
        jsonResponse({
          userQuota: { remaining: 100, used: 0, total: 100 },
          orgResourcePackage: {
            remaining: 952,
            used: 1548,
            cap: 2500,
            available: true,
          },
        }),
    });
    expect(quota.remaining).toBe(1052);
    expect(quota.shared).toMatchObject({ remaining: 952, total: 2500 });
  });

  it("excludes an unavailable shared pool", async () => {
    const quota = await fetchQoderQuota(endpointsFor(), "jt", {
      fetchImpl: async () =>
        jsonResponse({
          userQuota: { remaining: 100, used: 0, total: 100 },
          orgResourcePackage: {
            remaining: 999,
            used: 0,
            cap: 2500,
            available: false,
          },
        }),
    });
    expect(quota.remaining).toBe(100);
  });

  it("treats cap=-1 as an unlimited pool", async () => {
    const quota = await fetchQoderQuota(endpointsFor(), "jt", {
      fetchImpl: async () =>
        jsonResponse({
          orgResourcePackage: { remaining: 0, used: 0, cap: -1 },
        }),
    });
    expect(quota.total).toBe(-1);
    expect(quota.shared?.unlimited).toBe(true);
  });

  it("rejects a response with no quota containers", async () => {
    await expect(
      fetchQoderQuota(endpointsFor(), "jt", {
        fetchImpl: async () => jsonResponse({ isQuotaExceeded: true }),
      }),
    ).rejects.toMatchObject({ code: "quota-invalid" });
  });

  it("maps HTTP errors to a coded HubError", async () => {
    await expect(
      fetchQoderQuota(endpointsFor(), "jt", {
        fetchImpl: async () => jsonResponse({ message: "denied" }, 403),
      }),
    ).rejects.toMatchObject({ code: "quota-failed", status: 403 });
  });
});