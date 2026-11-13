export interface HubModelCapabilities {
  vision?: boolean;
  tool_calls?: boolean;
  reasoning?: boolean;
}

/** A model entry as returned by Qoder Direct's `/v1/models`. */
export interface HubModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  name?: string;
  name_local?: string;
  description?: string;
  upstream_key?: string;
  aliases?: string[];
  enabled?: boolean;
  disabled_reason?: string;
  realm?: string;
  capabilities?: HubModelCapabilities;
  supports_tool_calls?: boolean;
  supports_vision?: boolean;
  supports_images?: boolean;
  supports_reasoning?: boolean;
  context_length?: number;
  max_input_tokens?: number;
  context_windows?: number[];
  context_window_labels?: string[];
  context_window_default?: string;
  max_output_tokens?: number;
  max_completion_tokens?: number;
  reasoning_efforts?: string[];
  reasoning_default_effort?: string;
  reasoning_can_disable?: boolean;
  [key: string]: unknown;
}

export interface ModelOverride {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
}

/**
 * The shape consumed by the VS Code provider. `isUserSelectable` and `isBYOK`
 * are undocumented runtime fields: without `isUserSelectable` Copilot Chat
 * never offers the model in its in-chat picker.
 */
export interface ModelConfigurationProperty {
  type: "string" | "number";
  title: string;
  enum: Array<string | number>;
  enumItemLabels?: string[];
  enumDescriptions?: string[];
  default?: string | number;
  group?: string;
}

export interface ModelConfigurationSchema {
  properties: Record<string, ModelConfigurationProperty>;
}

export interface ProviderModel {
  id: string;
  name: string;
  family: string;
  version: string;
  detail?: string;
  tooltip?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Full context window (input + output) for VS Code's context-size UI. */
  maxContextWindowTokens?: number;
  /** Per-model picker options rendered by VS Code (Effort Level, Context Size). */
  configurationSchema?: ModelConfigurationSchema;
  capabilities: {
    toolCalling: boolean;
    imageInput: boolean;
  };
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  isUserSelectable: true;
  isBYOK: true;
  upstreamKey: string;
  realm?: string;
}
