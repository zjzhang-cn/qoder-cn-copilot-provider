import { HubError } from "../backend";
import { isRecord } from "../core/util";
import { CN_USER_AGENT, QUOTA_PATH } from "./constants";
import type { QoderEndpoints } from "./endpoints";
import type { OAuthDeps } from "./oauth";

/** One quota container (base, add-on, or org shared pool). */
export interface QuotaBucket {
  remaining: number;
  used: number;
  total: number;
  /** Org shared pools may declare themselves unavailable. */
  available: boolean;
  /** cap = -1 sentinel means an unlimited pool. */
  unlimited: boolean;
}

export interface QoderQuota {
  /** Sum of remaining across available buckets. */
  remaining: number;
  used: number;
  total: number;
  base?: QuotaBucket;
  addOn?: QuotaBucket;
  shared?: QuotaBucket;
}

export interface QuotaDeps extends OAuthDeps {}

/**
 * Read the account's credit quota. CN-only single-account port of the hub's
 * fetch_credits: GET /api/v2/quota/usage with the bearer token, aggregating
 * userQuota + addOnQuota + orgResourcePackage. Defensive against the upstream
 * degenerate shapes (missing containers, cap=-1 unlimited sentinel).
 */
export async function fetchQoderQuota(
  endpoints: QoderEndpoints,
  accessToken: string,
  deps: QuotaDeps = {},
): Promise<QoderQuota> {
  const response = await (deps.fetchImpl ?? fetch)(
    `${endpoints.openapi}${QUOTA_PATH}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": CN_USER_AGENT,
      },
      signal: quotaSignal(deps),
    },
  );
  if (!response.ok) {
    const err = new HubError(
      "Failed to read Qoder quota.",
      response.status,
    );
    err.code = "quota-failed";
    throw err;
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    const err = new HubError("Qoder quota response was not an object.");
    err.code = "quota-invalid";
    throw err;
  }
  return parseQuota(payload);
}

function parseQuota(payload: Record<string, unknown>): QoderQuota {
  const base = readBucket(payload.userQuota);
  const addOn = readBucket(payload.addOnQuota);
  const shared = readSharedBucket(payload);

  // Reject the "never had quota" degenerate shape rather than reporting 0.
  if (!base && !addOn && !shared) {
    const err = new HubError("Qoder quota response contained no quota data.");
    err.code = "quota-invalid";
    throw err;
  }

  const buckets = [base, addOn, shared].filter(
    (bucket): bucket is QuotaBucket => bucket !== undefined && bucket.available,
  );
  const unlimited = buckets.some((bucket) => bucket.unlimited);
  return {
    remaining: sum(buckets, "remaining"),
    used: sum(buckets, "used"),
    total: unlimited ? -1 : sum(buckets, "total"),
    ...(base ? { base } : {}),
    ...(addOn ? { addOn } : {}),
    ...(shared ? { shared } : {}),
  };
}

function readBucket(value: unknown): QuotaBucket | undefined {
  if (!isRecord(value)) return undefined;
  return {
    remaining: num(value.remaining),
    used: num(value.used),
    total: num(value.total),
    available: true,
    unlimited: false,
  };
}

function readSharedBucket(
  payload: Record<string, unknown>,
): QuotaBucket | undefined {
  for (const key of [
    "orgResourcePackage",
    "sharedQuota",
    "teamQuota",
    "poolQuota",
  ]) {
    const value = payload[key];
    if (!isRecord(value)) continue;
    const total = num(value.cap ?? value.total);
    const available = value.available !== false && value.available !== null;
    return {
      remaining: num(value.remaining),
      used: num(value.used),
      total,
      available,
      unlimited: total < 0,
    };
  }
  return undefined;
}

function sum(buckets: QuotaBucket[], field: "remaining" | "used" | "total"): number {
  return buckets.reduce((acc, bucket) => acc + Math.max(0, bucket[field]), 0);
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quotaSignal(deps: QuotaDeps): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
}