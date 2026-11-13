import {
  CN_GATEWAY,
  CN_OPENAPI,
  CN_WEBSITE,
  VPC_DOMAIN_SUFFIX,
} from "./constants";

export interface QoderEndpoints {
  realm: "cn";
  instance?: string;
  website: string;
  openapi: string;
  gateway: string;
}

const INSTANCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,53}[a-z0-9])?$/;

/**
 * Q26 A: accept only a bare VPC instance name/ID. Full URLs, ports, paths and
 * arbitrary hosts are rejected; the three hosts are always derived here.
 */
export function normalizeVpcInstance(value: string): string | undefined {
  const instance = value.trim().toLowerCase();
  if (!instance) return undefined;
  if (!INSTANCE_PATTERN.test(instance)) {
    throw new Error(
      "VPC instance must be a DNS label (letters, digits, hyphens; max 55 chars).",
    );
  }
  return instance;
}

export function endpointsFor(vpcInstance?: string): QoderEndpoints {
  const instance =
    vpcInstance === undefined ? undefined : normalizeVpcInstance(vpcInstance);
  if (!instance) {
    return {
      realm: "cn",
      website: CN_WEBSITE,
      openapi: CN_OPENAPI,
      gateway: CN_GATEWAY,
    };
  }
  const domain = `${instance}.${VPC_DOMAIN_SUFFIX}`;
  return {
    realm: "cn",
    instance,
    website: `https://${domain}`,
    openapi: `https://${instance}-openapi.${VPC_DOMAIN_SUFFIX}`,
    gateway: `https://${instance}-gateway.${VPC_DOMAIN_SUFFIX}`,
  };
}

export function describeEndpoints(endpoints: QoderEndpoints): string[] {
  return [
    `Website: ${endpoints.website}`,
    `OpenAPI: ${endpoints.openapi}`,
    `Gateway: ${endpoints.gateway}`,
  ];
}
