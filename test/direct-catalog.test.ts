import { describe, expect, it } from "vitest";
import { endpointsFor } from "../src/direct/endpoints";
import {
  fetchDirectModels,
  mapCatalogEntry,
  parseDirectCatalog,
  type QoderCatalogEntry,
} from "../src/direct/catalog";
import type { CosySession } from "../src/direct/cosy";

const ENTRY: QoderCatalogEntry = {
  key: "qmodel_38max",
  display_name: "Qwen3.8-Max",
  enable: true,
  max_input_tokens: 180000,
  is_vl: true,
  is_reasoning: true,
  context_config: {
    "1M": { token_count: 1_000_000 },
    "200K": { token_count: 200_000, is_default: true },
    "400K": { token_count: 400_000 },
  },
  thinking_config: {
    disabled: {},
    enabled: {
      efforts: {
        low: {},
        medium: { is_default: true },
        xhigh: {},
      },
    },
  },
};

describe("direct Qoder catalog", () => {
  it("maps an official entry to the canonical model shape", () => {
    const model = mapCatalogEntry(ENTRY);
    expect(model).toMatchObject({
      id: "qmodel_38max",
      name: "Qwen3.8-Max",
      upstream_key: "qmodel_38max",
      enabled: true,
      context_length: 180_000,
      context_windows: [1_000_000, 200_000, 400_000],
      context_window_labels: ["1M", "200K", "400K"],
      context_window_default: "200K",
      reasoning_efforts: ["low", "medium", "xhigh"],
      reasoning_default_effort: "medium",
      reasoning_can_disable: true,
      supports_tool_calls: true,
      capabilities: {
        vision: true,
        tool_calls: true,
        reasoning: true,
      },
    });
  });

  it("deduplicates chat and app scenes and keeps disabled entries", () => {
    const models = parseDirectCatalog({
      chat: [ENTRY],
      app: [ENTRY, { ...ENTRY, key: "disabled", enable: false }],
    });
    expect(models.map((entry) => entry.id)).toEqual([
      "qmodel_38max",
      "disabled",
    ]);
    expect(models[1]?.enabled).toBe(false);
  });

  it("fetches a signed GET with a body", async () => {
    let captured: {
      url: string;
      body?: string;
      headers: Record<string, string>;
    } | undefined;
    const session = {
      headers: () => ({ authorization: "Bearer COSY.test" }),
    } as unknown as CosySession;
    const models = await fetchDirectModels(
      endpointsFor("acme"),
      session,
      {
        request: async (url, request) => {
          captured = { url, body: request.body, headers: request.headers };
          return {
            status: 200,
            body: JSON.stringify({ chat: [ENTRY] }),
          };
        },
      },
    );
    expect(captured?.url).toBe(
      "https://acme-gateway.vpc.qoder.com.cn/algo/api/v2/model/list?Encode=1",
    );
    expect(captured?.body).toBe("$kwm");
    expect(captured?.headers.authorization).toBe("Bearer COSY.test");
    expect(models[0]?.id).toBe("qmodel_38max");
  });

  it("maps a non-200 response to HubError", async () => {
    const session = {
      headers: () => ({}),
    } as unknown as CosySession;
    await expect(
      fetchDirectModels(endpointsFor(), session, {
        request: async () => ({ status: 403, body: "denied" }),
      }),
    ).rejects.toMatchObject({ name: "HubError", status: 403 });
  });
});
