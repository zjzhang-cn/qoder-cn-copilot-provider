import {
  nonEmptyString,
  positiveInt,
} from "./util";
import type {
  HubModel,
  ModelConfigurationProperty,
  ModelConfigurationSchema,
  ModelOverride,
  ProviderModel,
} from "./types";

export const DEFAULT_MAX_INPUT_TOKENS = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

const CONTEXT_FRACTIONS = [1, 0.75, 0.5, 0.25] as const;
const MIN_CONTEXT_FOR_STEPS = 32_000;
const MIN_CONTEXT_OPTION = 8_000;

const EFFORT_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: "No reasoning — fastest, cheapest",
  minimal: "Minimal reasoning for fastest responses",
  low: "Faster responses with less reasoning",
  medium: "Balanced reasoning and speed",
  high: "Greater reasoning depth but slower",
  xhigh: "Highest reasoning depth but slowest",
  max: "Absolute maximum capability",
};

export interface ProviderModelOptions {
  excludedModels?: readonly string[];
  overrides?: Record<string, ModelOverride>;
}

interface ContextWindow {
  value: number;
  label: string;
}

interface ContextChoice {
  values: number[];
  labels: string[];
  default: number;
}

interface EffortChoice {
  values: string[];
  default: string;
}

export function parseModelsPayload(payload: unknown): HubModel[] {
  const raw = Array.isArray(payload)
    ? payload
    : typeof payload === "object" &&
        payload !== null &&
        Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : [];

  const byId = new Map<string, HubModel>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const id = nonEmptyString((item as { id?: unknown }).id);
    if (!id) continue;
    byId.set(id, item as HubModel);
  }
  return [...byId.values()];
}

export function toProviderModels(
  hubModels: readonly HubModel[],
  options: ProviderModelOptions = {},
): ProviderModel[] {
  const excluded = new Set(
    (options.excludedModels ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
  const overrides = buildOverrideMap(options.overrides ?? {});

  const result: ProviderModel[] = [];
  for (const model of hubModels) {
    if (model.enabled === false) continue;
    if (!nonEmptyString(model.id)) continue;

    const keys = modelKeys(model);
    if (keys.some((key) => excluded.has(key))) continue;

    const override = findOverride(overrides, keys);
    const overrideMaxInput = positiveInt(override?.maxInputTokens);
    const windows = hubContextWindows(model);
    const hubMaxInput =
      windows.length > 0
        ? Math.max(...windows.map((entry) => entry.value))
        : undefined;
    const maxInputTokens =
      overrideMaxInput ??
      hubMaxInput ??
      positiveInt(model.context_length) ??
      positiveInt(model.max_input_tokens) ??
      DEFAULT_MAX_INPUT_TOKENS;
    const requestedOutput =
      positiveInt(override?.maxOutputTokens) ??
      positiveInt(model.max_output_tokens) ??
      positiveInt(model.max_completion_tokens) ??
      DEFAULT_MAX_OUTPUT_TOKENS;
    const maxOutputTokens = Math.max(
      1,
      Math.min(requestedOutput, maxInputTokens),
    );
    const toolCalling =
      typeof override?.toolCalling === "boolean"
        ? override.toolCalling
        : typeof model.supports_tool_calls === "boolean"
          ? model.supports_tool_calls
          : typeof model.capabilities?.tool_calls === "boolean"
            ? model.capabilities.tool_calls
            : true;
    // Images stay disabled in v1. They can be opted into per model after the
    // hub's image support has been verified.
    const imageInput = override?.imageInput === true;
    const supportsReasoning =
      typeof model.supports_reasoning === "boolean"
        ? model.supports_reasoning
        : model.capabilities?.reasoning === true;
    const supportsVision =
      typeof model.supports_vision === "boolean"
        ? model.supports_vision
        : model.capabilities?.vision === true;

    const contextChoice = buildContextChoice(
      windows,
      model.context_window_default,
      maxInputTokens,
      overrideMaxInput === undefined,
    );
    const effortChoice = buildEffortChoice(model);
    const configurationSchema = buildConfigurationSchema(
      contextChoice,
      effortChoice,
    );

    const description = nonEmptyString(model.description);
    const tooltip = [
      description,
      `Context ${formatTokens(maxInputTokens)} · Output ${formatTokens(maxOutputTokens)} · Tools ${toolCalling ? "yes" : "no"}`,
      model.realm ? `Realm: ${model.realm}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    result.push({
      id: model.id,
      name:
        nonEmptyString(model.name_local) ??
        nonEmptyString(model.name) ??
        model.id,
      family: nonEmptyString(model.upstream_key) ?? model.id,
      version: "1.0.0",
      ...(nonEmptyString(model.upstream_key) &&
      model.upstream_key !== model.id
        ? { detail: model.upstream_key }
        : {}),
      tooltip,
      maxInputTokens,
      maxOutputTokens,
      maxContextWindowTokens: maxInputTokens + maxOutputTokens,
      ...(configurationSchema ? { configurationSchema } : {}),
      capabilities: { toolCalling, imageInput },
      supportsReasoning,
      supportsVision,
      isUserSelectable: true,
      isBYOK: true,
      upstreamKey: nonEmptyString(model.upstream_key) ?? model.id,
      ...(model.realm ? { realm: model.realm } : {}),
    });
  }
  return result;
}

export function modelKeys(model: HubModel): string[] {
  const keys = [
    model.id,
    model.upstream_key,
    ...(Array.isArray(model.aliases) ? model.aliases : []),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return [...new Set(keys)];
}

function buildOverrideMap(
  input: Record<string, ModelOverride>,
): Map<string, ModelOverride> {
  const map = new Map<string, ModelOverride>();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "object" || value === null) continue;
    const name = key.trim().toLowerCase();
    if (!name) continue;
    map.set(name, value);
  }
  return map;
}

function findOverride(
  overrides: Map<string, ModelOverride>,
  keys: readonly string[],
): ModelOverride | undefined {
  for (const key of keys) {
    const override = overrides.get(key);
    if (override) return override;
  }
  return undefined;
}

function hubContextWindows(model: HubModel): ContextWindow[] {
  const values = Array.isArray(model.context_windows)
    ? model.context_windows
        .map((value) => positiveInt(value))
        .filter((value): value is number => value !== undefined)
    : [];
  if (values.length === 0) return [];

  const labels = Array.isArray(model.context_window_labels)
    ? model.context_window_labels
    : [];
  return values
    .map((value, index) => ({
      value,
      label: nonEmptyString(labels[index]) ?? formatTokens(value),
    }))
    .sort((left, right) => right.value - left.value);
}

function buildContextChoice(
  windows: readonly ContextWindow[],
  defaultLabel: string | undefined,
  maxInputTokens: number,
  useHubWindows: boolean,
): ContextChoice | undefined {
  if (useHubWindows && windows.length > 1) {
    const values = windows.map((entry) => entry.value);
    const requestedDefault = nonEmptyString(defaultLabel);
    const defaultWindow =
      windows.find((entry) => entry.label === requestedDefault)?.value ??
      values[0] ??
      maxInputTokens;
    return {
      values,
      labels: windows.map((entry) => entry.label),
      default: defaultWindow,
    };
  }

  if (maxInputTokens < MIN_CONTEXT_FOR_STEPS) return undefined;
  const values = [
    ...new Set(
      CONTEXT_FRACTIONS.map((fraction) =>
        Math.floor(maxInputTokens * fraction),
      ).filter((value) => value >= MIN_CONTEXT_OPTION),
    ),
  ];
  if (values.length < 2) return undefined;
  return {
    values,
    labels: values.map(formatTokens),
    default: values[0] ?? maxInputTokens,
  };
}

function buildEffortChoice(model: HubModel): EffortChoice | undefined {
  const configured = Array.isArray(model.reasoning_efforts)
    ? model.reasoning_efforts
        .map((value) => nonEmptyString(value))
        .filter((value): value is string => Boolean(value))
    : [];
  const values =
    model.reasoning_can_disable === true && !configured.includes("none")
      ? ["none", ...configured]
      : configured;
  const unique = [...new Set(values)];
  if (unique.length < 2) return undefined;

  const requestedDefault = nonEmptyString(model.reasoning_default_effort);
  const defaultEffort =
    requestedDefault && unique.includes(requestedDefault)
      ? requestedDefault
      : unique.includes("medium")
        ? "medium"
        : (unique[0] ?? "medium");
  return { values: unique, default: defaultEffort };
}

function buildConfigurationSchema(
  context: ContextChoice | undefined,
  efforts: EffortChoice | undefined,
): ModelConfigurationSchema | undefined {
  const properties: Record<string, ModelConfigurationProperty> = {};

  if (efforts) {
    properties.reasoningEffort = {
      type: "string",
      title: "Effort Level",
      enum: efforts.values,
      enumItemLabels: efforts.values.map(
        (value) => EFFORT_LABELS[value] ?? value,
      ),
      enumDescriptions: efforts.values.map(
        (value) => EFFORT_DESCRIPTIONS[value] ?? value,
      ),
      default: efforts.default,
      group: "navigation",
    };
  }

  if (context) {
    const maximum = context.values[0] ?? context.default;
    properties.contextSize = {
      type: "number",
      title: "Context Size",
      enum: context.values,
      enumItemLabels: context.labels,
      enumDescriptions: context.values.map(
        (value) => `${Math.round((value / maximum) * 100)}% of the ${formatTokens(maximum)} window`,
      ),
      default: context.default,
      group: "tokens",
    };
  }

  return Object.keys(properties).length > 0 ? { properties } : undefined;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}
