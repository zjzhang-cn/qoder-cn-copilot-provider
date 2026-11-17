# ProviderModel 属性参考

本文整理扩展侧 `ProviderModel` 的全部属性，并对照 VS Code 的模型元数据定义，说明每个属性的来源、生成规则以及最终如何进入 `ILanguageModelChatMetadata`。

> 对照基准：VS Code `main` 分支（2026-11-17）。稳定版 `@types/vscode@1.136` 与 `main` 的 `LanguageModelChatInformation` 一致。文中上游路径均相对于 `microsoft/vscode` 仓库根目录。相关文档：[VS Code 模型发现机制](./model-discovery.md)。

## 1. 定位与数据流

`ProviderModel` 定义在 `src/core/types.ts:67`，是 `vscode.LanguageModelChatInformation` 的结构化超集：

- **稳定 API 字段**：VS Code 稳定版 typing 已声明的字段。
- **提案 API 字段**：位于 `chatProvider` / `languageModelPricing` 提案中的字段。稳定 typings 未声明，但运行时会作为普通对象属性被扩展宿主桥接层读取。
- **扩展内部字段**：只服务于本扩展构造上游请求，不进入 VS Code 元数据。

数据流：

```text
Qoder Hub /api/models  (HubModel)
        │  parseModelsPayload                     src/core/models.ts
        ▼
ModelStore（Memento 缓存 / TTL / single-flight）   src/core/modelStore.ts
        │  getModels()
        ▼
toProviderModels(hubModels, excluded, overrides)  src/core/models.ts:80
        │  过滤 + override + 能力/窗口推导
        ▼
ProviderModel[]                                   src/core/types.ts:67
        │  QoderProvider.provideLanguageModelChatInformation()
        ▼
ExtHostLanguageModels.$provideLanguageModelChatInfo
        │  逐字段映射为 ILanguageModelChatMetadata
        ▼
MainThreadLanguageModels（补 auth / 默认 isBYOK）
        ▼
LanguageModelsService 缓存 → 模型 picker / 聊天 / Manage Models
```

`ProviderModel` 由 `toProviderModels` 纯函数生成，与 VS Code 无关；`ILanguageModelChatMetadata` 由 VS Code 扩展宿主桥接层构造，扩展本身从不直接创建它。

## 2. 完整声明

```ts
// src/core/types.ts:67
export interface ProviderModel {
  id: string;
  name: string;
  family: string;
  version: string;
  detail?: string;
  tooltip?: string;
  multiplierNumeric?: number;
  pricing?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxContextWindowTokens?: number;
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
```

## 3. 属性总表

| # | 属性 | 类型 | VS Code 来源 | 进入 metadata | 生成规则（`toProviderModels`） |
|---|---|---|---|---|---|
| 1 | `id` | `string` | 稳定 API，必填 | `id` | `HubModel.id` |
| 2 | `name` | `string` | 稳定 API，必填 | `name` | `name_local ?? name ?? id` |
| 3 | `family` | `string` | 稳定 API，必填 | `family` | `upstream_key ?? id` |
| 4 | `version` | `string` | 稳定 API，必填 | `version` | 固定 `"1.0.0"` |
| 5 | `detail` | `string?` | 稳定 API，可选 | `detail` | 仅当 `upstream_key` 存在且不同于 `id` 时设为 `upstream_key` |
| 6 | `tooltip` | `string?` | 稳定 API，可选 | `tooltip` | `description` + `Context … · Output … · Tools yes/no` 行 + 可选 `Realm: …` 行 |
| 7 | `multiplierNumeric` | `number?` | `chatProvider` 提案 | `multiplierNumeric` | `price_factor`（有限且 ≥ 0 时） |
| 8 | `pricing` | `string?` | `languageModelPricing` 提案 | `pricing` | `price_factor === 0 ? "Free" : "${value}x"` |
| 9 | `maxInputTokens` | `number` | 稳定 API，必填 | `maxInputTokens` | override → `max(context_windows)` → `context_length` → `max_input_tokens` → `128_000` |
| 10 | `maxOutputTokens` | `number` | 稳定 API，必填 | `maxOutputTokens` | override → `max_output_tokens` → `max_completion_tokens` → `16_000`，再夹到 `[1, maxInputTokens]` |
| 11 | `maxContextWindowTokens` | `number?` | `chatProvider` 提案 | `maxContextWindowTokens` | `maxInputTokens + maxOutputTokens` |
| 12 | `configurationSchema` | `ModelConfigurationSchema?` | `chatProvider` 提案 | `configurationSchema` | 存在 ≥ 2 个 effort 档位或 ≥ 2 个 context 档位时生成 |
| 13 | `capabilities.toolCalling` | `boolean` | 稳定 API（`boolean \| number`） | `capabilities.toolCalling` + `capabilities.agentMode` | override → `supports_tool_calls` → `capabilities.tool_calls` → `true` |
| 14 | `capabilities.imageInput` | `boolean` | 稳定 API | 改名为 `capabilities.vision` | override → `supports_vision` → `capabilities.vision` |
| 15 | `supportsReasoning` | `boolean?` | 无对应 | 不转发 | `supports_reasoning` → `capabilities.reasoning` |
| 16 | `supportsVision` | `boolean?` | 无对应 | 不转发 | `supports_vision` → `capabilities.vision` |
| 17 | `isUserSelectable` | `true` | `chatProvider` 提案 | `isUserSelectable` | 固定 `true` |
| 18 | `isBYOK` | `true` | `chatProvider` 提案 | `isBYOK` | 固定 `true` |
| 19 | `upstreamKey` | `string` | 无对应 | 不转发 | `upstream_key ?? id` |
| 20 | `realm` | `string?` | 无对应 | 不转发 | `HubModel.realm`（存在时） |

## 4. 分组详解

### 4.1 稳定 API 字段（#1–6、#9–10、#13–14）

对应 `src/vscode-dts/vscode.d.ts` 中的 `LanguageModelChatInformation`：

```ts
readonly id: string;              // provider 内唯一标识
readonly name: string;            // 展示名
readonly family: string;          // 模型家族
readonly tooltip?: string;        // hover 描述
readonly detail?: string;         // 展示在模型旁边的次要文字
readonly version: string;         // 版本，用于 LanguageModelChatSelector.version 查找
readonly maxInputTokens: number;
readonly maxOutputTokens: number;
readonly capabilities: LanguageModelChatCapabilities;
```

`LanguageModelChatCapabilities` 定义为：

```ts
// src/vscode-dts/vscode.d.ts（stable）
export interface LanguageModelChatCapabilities {
    readonly imageInput?: boolean;
    readonly toolCalling?: boolean | number; // number 表示最多可用工具数
}
```

本地将 `toolCalling` 收窄为 `boolean`，不使用"最大工具数"语义。

### 4.2 提案 API 字段（#7–8、#11–12、#17–18）

这些字段不在稳定 typings 中，但扩展宿主桥接层会直接读取运行时对象：

| 字段 | 所在提案 | 官方说明 |
|---|---|---|
| `multiplierNumeric` | `chatProvider` | "A numeric value for comparing model cost tiers." |
| `maxContextWindowTokens` | `chatProvider` | 模型总上下文窗口（含输入与输出），独立于 `maxInputTokens` / `maxOutputTokens` |
| `configurationSchema` | `chatProvider` | 描述每模型配置的 JSON Schema；支持 `enumItemLabels`、`group`（`'navigation'` 时作为 picker 主操作） |
| `isUserSelectable` | `chatProvider` | 是否立即出现在模型 picker；标注为 **NOT BEING FINALIZED** |
| `isBYOK` | `chatProvider` | 是否用户自带密钥（非 Copilot CAPI 服务）；未声明时按 provider 归属推断 |
| `pricing` | `languageModelPricing` | 展示用价格标签，如 `"Free"`、`"$0.01/request"`；VS Code 不解析 |

`languageModelPricing` 还定义了 `inputCost`、`outputCost`、`cacheCost`、`cacheWriteCost`、`longContext*`、`priceCategory`、`category` 等结构化成本字段。本扩展**未使用**这些字段，只使用 `multiplierNumeric` + `pricing`。

`languageModelCapabilities` 提案还可为 `LanguageModelChatCapabilities` 增加 `apiType`、`adaptiveThinking` 与 `editTools`；本扩展未设置。

#### `configurationSchema` 的生成细节

本地类型（`src/core/types.ts:53-65`）：

```ts
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
```

`buildConfigurationSchema`（`src/core/models.ts:306`）会按需生成两个属性：

- `reasoningEffort`（`group: "navigation"`）
  - 取值来自 `reasoning_efforts`；若 `reasoning_can_disable === true`，前置 `"none"`。
  - 去重后少于 2 个值则不生成。
  - 默认值：`reasoning_default_effort`（若在取值内）→ `"medium"`（若存在）→ 第一个值。
  - 显示标签来自 `EFFORT_LABELS`，描述来自 `EFFORT_DESCRIPTIONS`。
- `contextSize`（`group: "tokens"`）
  - 若 Hub 提供多个 `context_windows` 且未被 override 覆盖，则直接使用这些窗口，默认取 `context_window_default` 匹配项或第一个。
  - 否则当 `maxInputTokens ≥ 32_000` 时，按 `[1, 0.75, 0.5, 0.25]` 生成档位（过滤掉 `< 8_000` 的值），少于 2 个则不生成。
  - 描述文案为相对最大窗口的百分比。

### 4.3 扩展内部字段（#15–16、#19–20）

| 字段 | 用途 | 不进入 VS Code 的原因 |
|---|---|---|
| `supportsReasoning` | 传给 `client.streamChat`，决定 `model_config.is_reasoning`（`provider.ts:167`、`direct/request.ts:85`） | metadata 没有 reasoning 能力字段 |
| `supportsVision` | 传给 `streamChat`，决定图片处理与 `model_config.is_vl`（`provider.ts:168`、`direct/request.ts:84`） | VS Code 使用 `capabilities.imageInput`；此字段是 catalog 原始能力，供请求层使用 |
| `upstreamKey` | 保留 Qoder 上游 key；当前仅存储与测试断言使用 | 纯本地概念 |
| `realm` | 写入 tooltip，提示模型所属 realm | 纯本地概念 |

## 5. 与 `ILanguageModelChatMetadata` 的映射

`ILanguageModelChatMetadata` 定义在 `src/vs/workbench/contrib/chat/common/languageModels.ts:264`，由 `extHostLanguageModels.ts:234-279` 从扩展返回值逐字段构造。

| ProviderModel | ILanguageModelChatMetadata | 规则 |
|---|---|---|
| `id` | `id` | 直接复制 |
| `name` | `name` | 直接复制 |
| `family` | `family` | 直接复制 |
| `version` | `version` | 直接复制 |
| `detail` / `tooltip` | `detail` / `tooltip` | 直接复制 |
| `multiplierNumeric` | `multiplierNumeric` | 直接复制 |
| `pricing` | `pricing` | 直接复制 |
| `maxInputTokens` / `maxOutputTokens` | 同名 | 直接复制 |
| `maxContextWindowTokens` | `maxContextWindowTokens` | 直接复制 |
| `configurationSchema` | `configurationSchema` | 直接复制 |
| `capabilities.toolCalling` | `capabilities.toolCalling` | 直接复制 |
| `capabilities.toolCalling` | `capabilities.agentMode` | 派生：`!!toolCalling` |
| `capabilities.imageInput` | `capabilities.vision` | 改名 |
| `isUserSelectable` | `isUserSelectable` | 直接复制 |
| `isBYOK` | `isBYOK` | 直接复制 |
| `supportsReasoning` | — | 丢弃 |
| `supportsVision` | — | 丢弃 |
| `upstreamKey` | — | 丢弃 |
| `realm` | — | 丢弃 |
| — | `extension` / `vendor` | 桥接层填入 provider 所属扩展与注册时的 vendor |
| — | `auth` | 仅当扩展设置 `requiresAuthorization` 时由桥接层构造 |
| — | `isDefaultForLocation` | 仅当启用 `chatProvider` 提案时由 `isDefault` 展开，否则 `{}` |
| — | `identifier` | 桥接层计算：`<vendor>/<group>/<id>` 或 `<vendor>/<id>` |

主线程还会在 `metadata.isBYOK === undefined` 时，按"是否内置 Copilot 扩展"补默认值；本扩展显式设为 `true`，不会被覆盖。

## 6. 过滤与默认值汇总

`toProviderModels` 在转换前会先过滤：

- `enabled === false` 的模型跳过。
- `id` 为空字符串的模型跳过。
- `id`、`upstream_key`、`aliases` 任一命中 `excludedModels`（忽略大小写）的模型跳过。
- 同 id 的 Hub 条目在 `parseModelsPayload` 阶段去重（后者覆盖前者）。

默认值：

| 属性 | 默认 |
|---|---|
| `maxInputTokens` | `128_000` |
| `maxOutputTokens` | `16_000`（且不超过 `maxInputTokens`） |
| `capabilities.toolCalling` | `true` |
| `capabilities.imageInput` | `false`（除非 catalog 标记为 vision） |
| `version` | `"1.0.0"` |
| `isUserSelectable` | `true` |
| `isBYOK` | `true` |

## 7. 注意事项

1. **稳定 typings 不认识提案字段**：`ProviderModel` 能作为 `vscode.LanguageModelChatInformation[]` 返回，依赖 TypeScript 结构化类型（多余属性不报错）；运行时由扩展宿主直接读取这些属性。
2. **`isUserSelectable` / `isBYOK` 是字面量 `true`**：类型上无法表达 `false`。若未来需要隐藏模型，应调整类型或改为条件添加。
3. **`multiplierNumeric` 与 `pricing` 必须成对设置**：picker 行内价格只在 `multiplierNumeric !== undefined` 时显示 `pricing`；hover/详情卡也以它作为倍率价格的主要开关。
4. **`price_factor` 无效时两个字段一起消失**：`creditPricing` 对非有限数或负数返回 `{}`。
5. **`detail` 不保证存在**：只有 `upstream_key` 与 `id` 不同才会设置。
6. **`tooltip` 是兜底描述**：一旦渲染了成本区块，hover 中不再显示 tooltip。
7. **`maxContextWindowTokens` 按输入 + 输出相加**：未对上游异常值做额外 clamp。
8. **`supports_images` 未被使用**：当前 `imageInput` 只参考 `supports_vision` 与 `capabilities.vision`。

## 8. 参考资料

本地：

- `src/core/types.ts` — `ProviderModel`、`ModelConfigurationSchema`、`ModelOverrides`
- `src/core/models.ts` — `toProviderModels`、`creditPricing`、`buildConfigurationSchema`
- `src/core/modelStore.ts` — 模型缓存与刷新
- `src/provider.ts` — `provideLanguageModelChatInformation` / 请求构造

VS Code：

- `src/vs/workbench/contrib/chat/common/languageModels.ts` — `ILanguageModelChatMetadata`
- `src/vs/workbench/api/common/extHostLanguageModels.ts` — provider 返回值 → metadata 映射
- `src/vs/workbench/api/browser/mainThreadLanguageModels.ts` — auth / `isBYOK` 兜底
- `src/vscode-dts/vscode.d.ts` — 稳定 `LanguageModelChatInformation`
- `src/vscode-dts/vscode.proposed.chatProvider.d.ts` — `multiplierNumeric`、`maxContextWindowTokens`、`configurationSchema`、`isUserSelectable`、`isBYOK` 等
- `src/vscode-dts/vscode.proposed.languageModelPricing.d.ts` — `pricing` 与结构化成本字段
- `src/vscode-dts/vscode.proposed.languageModelCapabilities.d.ts` — `apiType`、`adaptiveThinking`、`editTools`
- `src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/` — picker 对价格/倍率的消费逻辑