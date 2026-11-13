import { request as httpsRequest, type RequestOptions } from "node:https";
import { HubError } from "../backend";
import type { HubModel } from "../core/types";
import { isRecord } from "../core/util";
import { MODELS_PATH } from "./constants";
import type { QoderEndpoints } from "./endpoints";
import { qoderEncode } from "./encode";
import type { CosySession } from "./cosy";

export interface CatalogHttpRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CatalogHttpResponse {
  status: number;
  body: string;
}

export type CatalogRequest = (
  url: string,
  request: CatalogHttpRequest,
) => Promise<CatalogHttpResponse>;

export interface DirectCatalogDeps {
  request?: CatalogRequest;
  signal?: AbortSignal;
}

interface ContextConfigEntry {
  token_count?: unknown;
  is_default?: unknown;
}

interface ThinkingEffortEntry {
  is_default?: unknown;
}

interface ThinkingConfig {
  enabled?: {
    efforts?: Record<string, ThinkingEffortEntry>;
    is_default?: unknown;
  };
  disabled?: unknown;
}

export interface QoderCatalogEntry {
  key: string;
  display_name?: string;
  enable?: boolean;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  context_config?: Record<string, ContextConfigEntry>;
  thinking_config?: ThinkingConfig;
  is_vl?: boolean;
  is_reasoning?: boolean;
  disabled_message_key?: string;
  [key: string]: unknown;
}

export async function fetchDirectModels(
  endpoints: QoderEndpoints,
  session: CosySession,
  deps: DirectCatalogDeps = {},
): Promise<HubModel[]> {
  const url = `${endpoints.gateway}${MODELS_PATH}`;
  const body = qoderEncode("{}");
  const headers = session.headers(body, url, { accept: "application/json" });
  const result = await (deps.request ?? httpsRequestText)(url, {
    method: "GET",
    headers,
    body,
    signal: deps.signal,
    timeoutMs: 15_000,
  });
  if (result.status !== 200) {
    throw new HubError(
      `Qoder model list failed with HTTP ${result.status}.`,
      result.status,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.body);
  } catch {
    throw new HubError("Qoder model list returned invalid JSON.");
  }
  return parseDirectCatalog(payload);
}

export function parseDirectCatalog(payload: unknown): HubModel[] {
  if (!isRecord(payload)) return [];
  const entries: QoderCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const scene of ["chat", "app"]) {
    const list = payload[scene];
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      if (!isRecord(value)) continue;
      const key = typeof value.key === "string" ? value.key.trim() : "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(value as QoderCatalogEntry);
    }
  }
  return entries.map(mapCatalogEntry);
}

export function mapCatalogEntry(entry: QoderCatalogEntry): HubModel {
  const displayName =
    typeof entry.display_name === "string" && entry.display_name.trim()
      ? entry.display_name.trim()
      : entry.key;
  const contexts = contextWindows(entry);
  const efforts = reasoningEfforts(entry);
  const maxOutput = positiveInt(entry.max_output_tokens) ??
    positiveInt(entry.max_tokens);

  return {
    id: entry.key,
    name: displayName,
    name_local: displayName,
    upstream_key: entry.key,
    enabled: entry.enable !== false,
    description: undefined,
    realm: "cn",
    context_length: positiveInt(entry.max_input_tokens),
    max_input_tokens: positiveInt(entry.max_input_tokens),
    context_windows: contexts.windows,
    context_window_labels: contexts.labels,
    context_window_default: contexts.defaultLabel,
    max_output_tokens: maxOutput,
    reasoning_efforts: efforts.values,
    reasoning_default_effort: efforts.defaultValue,
    reasoning_can_disable: efforts.canDisable,
    supports_tool_calls: true,
    capabilities: {
      vision: entry.is_vl === true,
      tool_calls: true,
      reasoning: entry.is_reasoning === true,
    },
    ...(typeof entry.disabled_message_key === "string"
      ? { disabled_reason: entry.disabled_message_key }
      : {}),
  };
}

function contextWindows(entry: QoderCatalogEntry): {
  windows: number[];
  labels: string[];
  defaultLabel?: string;
} {
  const windows: number[] = [];
  const labels: string[] = [];
  let defaultLabel: string | undefined;
  for (const [label, value] of Object.entries(entry.context_config ?? {})) {
    if (!isRecord(value)) continue;
    const tokenCount = positiveInt(value.token_count);
    if (tokenCount === undefined) continue;
    labels.push(label);
    windows.push(tokenCount);
    if (value.is_default === true) defaultLabel = label;
  }
  return { windows, labels, defaultLabel };
}

function reasoningEfforts(entry: QoderCatalogEntry): {
  values: string[];
  defaultValue?: string;
  canDisable: boolean;
} {
  const enabled = entry.thinking_config?.enabled;
  const rawEfforts = isRecord(enabled?.efforts) ? enabled.efforts : {};
  const values: string[] = [];
  let defaultValue: string | undefined;
  for (const [effort, value] of Object.entries(rawEfforts)) {
    if (!effort.trim()) continue;
    values.push(effort);
    if (isRecord(value) && value.is_default === true) defaultValue = effort;
  }
  if (!defaultValue && enabled?.is_default === true && values.includes("medium")) {
    defaultValue = "medium";
  }
  return {
    values,
    defaultValue,
    canDisable:
      entry.thinking_config?.disabled !== undefined &&
      entry.thinking_config.disabled !== null,
  };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function httpsRequestText(
  url: string,
  request: CatalogHttpRequest,
): Promise<CatalogHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      reject(new Error(`Only HTTPS is allowed: ${parsed.protocol}`));
      return;
    }
    const headers = { ...request.headers };
    if (request.body !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(request.body));
    }
    const options: RequestOptions = {
      method: request.method,
      headers,
      signal: request.signal,
    };
    const req = httpsRequest(parsed, options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(request.timeoutMs ?? 15_000, () => {
      req.destroy(new Error("Qoder model list request timed out."));
    });
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}
