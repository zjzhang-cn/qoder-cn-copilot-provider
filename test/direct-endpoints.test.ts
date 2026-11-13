import { describe, expect, it } from "vitest";
import {
  describeEndpoints,
  endpointsFor,
  normalizeVpcInstance,
} from "../src/direct/endpoints";

describe("direct Qoder endpoints", () => {
  it("returns the public CN hosts", () => {
    const endpoints = endpointsFor();
    expect(endpoints).toEqual({
      realm: "cn",
      website: "https://qoder.com.cn",
      openapi: "https://openapi.qoder.com.cn",
      gateway: "https://gateway.qoder.com.cn",
    });
  });

  it("derives the three VPC hosts from an instance", () => {
    const endpoints = endpointsFor("acme");
    expect(endpoints.instance).toBe("acme");
    expect(endpoints.website).toBe("https://acme.vpc.qoder.com.cn");
    expect(endpoints.openapi).toBe(
      "https://acme-openapi.vpc.qoder.com.cn",
    );
    expect(endpoints.gateway).toBe(
      "https://acme-gateway.vpc.qoder.com.cn",
    );
    expect(describeEndpoints(endpoints)).toHaveLength(3);
  });

  it("normalizes and validates instance names", () => {
    expect(normalizeVpcInstance("  ACME ")).toBe("acme");
    expect(normalizeVpcInstance("")).toBeUndefined();
    expect(() => normalizeVpcInstance("acme.vpc.qoder.com.cn")).toThrow();
    expect(() => normalizeVpcInstance("https://acme")).toThrow();
    expect(() => normalizeVpcInstance("acme:8443")).toThrow();
    expect(() => normalizeVpcInstance("-acme")).toThrow();
  });
});
