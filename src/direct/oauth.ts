import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HubError } from "../backend";
import {
  CN_CLIENT_ID,
  CN_LOGIN_USER_AGENT,
  CN_REDIRECT_URI,
  CN_USER_AGENT,
  DEVICE_POLL_PATH,
  DEVICE_REFRESH_PATH,
  USERINFO_PATH,
} from "./constants";
import type { QoderEndpoints } from "./endpoints";

export interface PendingLogin {
  instance?: string;
  verifier: string;
  nonce: string;
  machineId: string;
  createdAt: number;
}

export interface DeviceLoginStart {
  pending: PendingLogin;
  authUrl: string;
}

export interface DeviceLoginResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
}

export interface QoderUserInfo {
  id: string;
  name?: string;
  userType?: string;
  organizationId?: string;
  organizationName?: string;
}

export interface OAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

interface TokenPayload {
  token?: unknown;
  device_token?: unknown;
  refresh_token?: unknown;
  user_id?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
  expire_time?: unknown;
}

export function startDeviceLogin(
  endpoints: QoderEndpoints,
  options: { machineId?: string; now?: () => number } = {},
): DeviceLoginStart {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(
    createHash("sha256").update(verifier).digest(),
  );
  const nonce = randomUUID();
  const machineId = options.machineId ?? randomUUID();
  const query = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    redirect_uri: CN_REDIRECT_URI,
    client_id: CN_CLIENT_ID,
    machine_id: machineId,
  });
  return {
    pending: {
      instance: endpoints.instance,
      verifier,
      nonce,
      machineId,
      createdAt: (options.now ?? Date.now)(),
    },
    authUrl: `${endpoints.website}/device/selectAccounts?${query.toString()}`,
  };
}

export async function pollDeviceLogin(
  endpoints: QoderEndpoints,
  pending: PendingLogin,
  deps: OAuthDeps = {},
): Promise<DeviceLoginResult | undefined> {
  const query = new URLSearchParams({
    nonce: pending.nonce,
    verifier: pending.verifier,
    challenge_method: "S256",
  });
  const response = await (deps.fetchImpl ?? fetch)(
    `${endpoints.openapi}${DEVICE_POLL_PATH}?${query.toString()}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": CN_LOGIN_USER_AGENT,
      },
      signal: requestSignal(deps),
    },
  );
  if (response.status === 202 || response.status === 404) return undefined;
  if (!response.ok) throw await authError(response, "Device authorization failed");
  return parseTokenPayload(await response.json(), deps.now ?? Date.now);
}

export async function fetchQoderUserInfo(
  endpoints: QoderEndpoints,
  accessToken: string,
  deps: OAuthDeps = {},
): Promise<QoderUserInfo> {
  const response = await (deps.fetchImpl ?? fetch)(
    `${endpoints.openapi}${USERINFO_PATH}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": CN_USER_AGENT,
      },
      signal: requestSignal(deps),
    },
  );
  if (!response.ok) throw await authError(response, "Failed to read Qoder user info");
  const payload = (await response.json()) as Record<string, unknown>;
  const id = firstString(payload.id, payload.uid, payload.user_id);
  if (!id) throw new HubError("Qoder user info did not contain an id.", response.status);
  return {
    id,
    name: firstString(payload.name, payload.nickname),
    userType: firstString(payload.user_type, payload.userType),
    organizationId: firstString(
      payload.organization_id,
      payload.organizationId,
    ),
    organizationName: firstString(
      payload.organization_name,
      payload.organizationName,
    ),
  };
}

export async function refreshDeviceToken(
  endpoints: QoderEndpoints,
  refreshToken: string,
  deps: OAuthDeps = {},
): Promise<DeviceLoginResult> {
  const response = await (deps.fetchImpl ?? fetch)(
    `${endpoints.openapi}${DEVICE_REFRESH_PATH}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": CN_USER_AGENT,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: requestSignal(deps),
    },
  );
  if (!response.ok) throw await authError(response, "Qoder token refresh failed");
  return parseTokenPayload(await response.json(), deps.now ?? Date.now);
}

function parseTokenPayload(
  payload: unknown,
  now: () => number,
): DeviceLoginResult {
  if (typeof payload !== "object" || payload === null) {
    throw new HubError("Qoder returned an invalid token payload.");
  }
  const data = payload as TokenPayload;
  const accessToken = firstString(data.token, data.device_token);
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  const userId = firstString(data.user_id);
  if (!accessToken || !refreshToken || !userId) {
    throw new HubError("Qoder token payload is incomplete.");
  }
  return {
    accessToken,
    refreshToken,
    userId,
    expiresAt: parseExpiry(data, now()),
  };
}

function parseExpiry(data: TokenPayload, now: number): number {
  const expiresIn = numberValue(data.expires_in);
  if (expiresIn !== undefined) {
    // The hub treats expires_in as milliseconds.
    return now + expiresIn;
  }
  const expiresAt = dateValue(data.expires_at) ?? dateValue(data.expire_time);
  if (expiresAt !== undefined) return expiresAt;
  return now + 30 * 24 * 60 * 60 * 1000;
}

function requestSignal(deps: OAuthDeps): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url").replace(/=+$/g, "");
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function dateValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

async function authError(response: Response, fallback: string): Promise<HubError> {
  let detail = fallback;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const error = body.error;
    if (typeof body.message === "string" && body.message.trim()) {
      detail = body.message.trim();
    } else if (typeof error === "string" && error.trim()) {
      detail = error.trim();
    } else if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) detail = message.trim();
    }
  } catch {
    // Keep the fallback.
  }
  return new HubError(detail, response.status);
}
