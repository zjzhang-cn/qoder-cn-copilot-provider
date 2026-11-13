import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  parseModelsPayload,
  toProviderModels,
} from "../src/core/models";
import type { HubModel } from "../src/core/types";

function model(overrides: Partial<HubModel> = {}): HubModel {
  return { id: "Qwen3.8-Max", enabled: true, ...overrides };
}

describe("parseModelsPayload", () => {
  it("reads the OpenAI list envelope and deduplicates by id", () => {
    const parsed = parseModelsPayload({
      object: "list",
      data: [
        model({ id: "a" }),
        model({ id: "b" }),
        model({ id: "a", description: "last wins" }),
        { name: "missing id" },
      ],
    });
    expect(parsed.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(parsed[0]?.description).toBe("last wins");
  });

  it("accepts a bare array", () => {
    expect(parseModelsPayload([model({ id: "x" })])).toHaveLength(1);
  });

  it("returns an empty list for garbage", () => {
    expect(parseModelsPayload(null)).toEqual([]);
    expect(parseModelsPayload({ data: "nope" })).toEqual([]);
  });
});

describe("toProviderModels", () => {
  it("filters disabled models", () => {
    const result = toProviderModels([
      model({ id: "on" }),
      model({ id: "off", enabled: false, disabled_reason: "no plan" }),
    ]);
    expect(result.map((entry) => entry.id)).toEqual(["on"]);
  });

  it("uses hub limits and capabilities", () => {
    const [entry] = toProviderModels([
      model({
        context_length: 180_000,
        max_output_tokens: 32_000,
        supports_tool_calls: false,
        capabilities: { vision: true, tool_calls: true },
      }),
    ]);
    expect(entry?.maxInputTokens).toBe(180_000);
    expect(entry?.maxOutputTokens).toBe(32_000);
    expect(entry?.capabilities.toolCalling).toBe(false);
    // Vision capability now drives image input (catalog is_vl).
    expect(entry?.capabilities.imageInput).toBe(true);
  });

  it("gates image input on vision and honors the override", () => {
    const [vision] = toProviderModels([
      model({ capabilities: { vision: true } }),
    ]);
    expect(vision?.capabilities.imageInput).toBe(true);

    const [noVision] = toProviderModels([
      model({ capabilities: { vision: false } }),
    ]);
    expect(noVision?.capabilities.imageInput).toBe(false);

    const [forcedOff] = toProviderModels(
      [model({ capabilities: { vision: true } })],
      { overrides: { "qwen3.8-max": { imageInput: false } } },
    );
    expect(forcedOff?.capabilities.imageInput).toBe(false);

    const [forcedOn] = toProviderModels(
      [model({ capabilities: { vision: false } })],
      { overrides: { "qwen3.8-max": { imageInput: true } } },
    );
    expect(forcedOn?.capabilities.imageInput).toBe(true);
  });

  it("falls back to 128k input and 16k output", () => {
    const [entry] = toProviderModels([model()]);
    expect(entry?.maxInputTokens).toBe(DEFAULT_MAX_INPUT_TOKENS);
    expect(entry?.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(entry?.capabilities.toolCalling).toBe(true);
  });

  it("exposes hub context windows and keeps the official default", () => {
    const [entry] = toProviderModels([
      model({
        context_windows: [1_000_000, 200_000, 400_000],
        context_window_labels: ["1M", "200K", "400K"],
        context_window_default: "200K",
      }),
    ]);
    expect(entry?.maxInputTokens).toBe(1_000_000);
    expect(entry?.maxContextWindowTokens).toBe(1_016_000);
    const context = entry?.configurationSchema?.properties.contextSize;
    expect(context?.enum).toEqual([1_000_000, 400_000, 200_000]);
    expect(context?.enumItemLabels).toEqual(["1M", "400K", "200K"]);
    expect(context?.default).toBe(200_000);
    expect(context?.group).toBe("tokens");
  });

  it("offers context fractions when the hub has no window list", () => {
    const [entry] = toProviderModels([model({ context_length: 100_000 })]);
    const context = entry?.configurationSchema?.properties.contextSize;
    expect(context?.enum).toEqual([100_000, 75_000, 50_000, 25_000]);
    expect(context?.default).toBe(100_000);
  });

  it("exposes the hub's reasoning effort levels", () => {
    const [entry] = toProviderModels([
      model({
        reasoning_efforts: ["low", "medium", "xhigh"],
        reasoning_default_effort: "medium",
        reasoning_can_disable: true,
      }),
    ]);
    const effort = entry?.configurationSchema?.properties.reasoningEffort;
    expect(effort?.enum).toEqual(["none", "low", "medium", "xhigh"]);
    expect(effort?.enumItemLabels).toContain("Medium");
    expect(effort?.default).toBe("medium");
    expect(effort?.group).toBe("navigation");
  });

  it("does not exceed the input limit with the output limit", () => {
    const [entry] = toProviderModels([
      model({ context_length: 8_000, max_output_tokens: 32_000 }),
    ]);
    expect(entry?.maxOutputTokens).toBe(8_000);
  });

  it("excludes models by alias or upstream key", () => {
    const result = toProviderModels(
      [
        model({
          id: "Qwen3.8-Max",
          upstream_key: "qmodel_38max",
          aliases: ["qwen3.8-max"],
        }),
      ],
      { excludedModels: ["QWEN3.8-MAX"] },
    );
    expect(result).toEqual([]);
  });

  it("applies per-model overrides by upstream key", () => {
    const [entry] = toProviderModels(
      [model({ id: "Qwen3.8-Max", upstream_key: "qmodel_38max" })],
      {
        overrides: {
          qmodel_38max: {
            maxInputTokens: 64_000,
            maxOutputTokens: 4_000,
            toolCalling: false,
            imageInput: true,
          },
        },
      },
    );
    expect(entry?.maxInputTokens).toBe(64_000);
    expect(entry?.maxOutputTokens).toBe(4_000);
    expect(entry?.capabilities).toEqual({
      toolCalling: false,
      imageInput: true,
    });
  });

  it("keeps the picker-only fields and stable upstream key", () => {
    const [entry] = toProviderModels([
      model({
        id: "Kimi-K3.1-Pro",
        name_local: "Kimi K3.1 Pro",
        upstream_key: "kmodel_latest",
        realm: "cn",
      }),
    ]);
    expect(entry).toMatchObject({
      id: "Kimi-K3.1-Pro",
      name: "Kimi K3.1 Pro",
      family: "kmodel_latest",
      upstreamKey: "kmodel_latest",
      isUserSelectable: true,
      isBYOK: true,
      realm: "cn",
    });
    expect(entry?.tooltip).toContain("Context 128k");
  });
});
