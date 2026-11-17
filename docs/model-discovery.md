# VS Code 模型发现机制

本文说明 VS Code 如何发现一个扩展提供的语言模型：从 `package.json` 声明 vendor，到扩展激活、provider 注册、模型解析、缓存，再到模型 picker 和 `vscode.lm` API 使用。文末给出本扩展（Qoder CN Provider for Copilot）的具体行为。

> 对照基准：VS Code `main` 分支（2026-11-17）。上游路径相对于 `microsoft/vscode` 仓库根目录。相关文档：[ProviderModel 属性参考](./provider-model.md)。

## 1. 总览

模型发现是**拉模型（pull）**，不是扩展主动推送：

```text
① 静态声明   package.json contributes.languageModelChatProviders
                → 注册 vendor + 生成激活事件

② 激活注册   onLanguageModelChatProvider:<vendor>
                → extension activate()
                → vscode.lm.registerLanguageModelChatProvider(vendor, provider)
                → extHost → mainThread → LanguageModelsService

③ 触发解析   LanguageModelsService._resolveAllLanguageModels(vendor)
                → 调用 provider.provideLanguageModelChatInfo()
                → 先解析 groupless，再对每个 provider group 解析一次

④ 转换缓存   扩展返回值 → ILanguageModelChatMetadata + identifier
                → 写入 _modelCache / _modelsGroups
                → 触发 onDidChangeLanguageModels

⑤ 消费       模型 picker / Chat / vscode.lm.selectChatModels / Manage Models
```

关键角色：

| 组件 | 位置 | 职责 |
|---|---|---|
| `languageModelChatProviders` 扩展点 | `src/vs/workbench/contrib/chat/common/languageModels.ts:1048` | 解析 vendor 声明，生成激活事件 |
| `ExtHostLanguageModels` | `src/vs/workbench/api/common/extHostLanguageModels.ts` | 扩展宿主侧注册表；调用扩展 provider；把返回值映射为 metadata |
| `MainThreadLanguageModels` | `src/vs/workbench/api/browser/mainThreadLanguageModels.ts` | 主进程桥接；注册 auth、补默认 `isBYOK` |
| `LanguageModelsService` | `src/vs/workbench/contrib/chat/common/languageModels.ts:1225` | 模型解析调度、缓存、分组、查询 API |
| `ILanguageModelsConfigurationService` | `src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts` | provider group 的持久化配置 |
| `QoderProvider` | `src/provider.ts:34` | 本扩展的 provider 实现 |
| `ModelStore` | `src/core/modelStore.ts:37` | 本扩展的模型缓存，数据来自 Qoder Hub |

## 2. 阶段一：静态声明

扩展在 `package.json` 中声明 vendor：

```json
// package.json
"activationEvents": ["onLanguageModelChatProvider:qoder-direct"],
"contributes": {
  "languageModelChatProviders": [{
    "vendor": "qoder-direct",
    "displayName": "%provider.displayName%",
    "managementCommand": "qoderDirect.signIn",
    "configuration": {
      "type": "object",
      "properties": {
        "account":  { "type": "string", "title": "Account",   "readOnly": true },
        "instance": { "type": "string", "title": "VPC Instance", "readOnly": true }
      }
    }
  }]
}
```

扩展点解析（`languageModels.ts:1334-1367`）会构建 vendor 描述符：

- `vendor`：唯一 id，provider 注册时使用。
- `displayName`：Manage Models / picker 中展示。
- `managementCommand`：该 vendor 的"管理/添加实例"命令。
- `configuration`：JSON Schema，决定该 vendor 是否支持**命名 provider group**，以及 group 配置如何采集。
- `when` / `icon` / `deprecation`：可选展示与可见性控制。

同时扩展点通过 `activationEventsGenerator`（`languageModels.ts:1060-1064`）生成：

```text
onLanguageModelChatProvider:<vendor>
```

即使 `package.json` 不显式写 `activationEvents`，该事件也会由贡献点自动生成；本扩展显式声明只是为了清晰。

vendor 未声明就注册 provider 会抛错：

```text
Chat model provider uses UNKNOWN vendor <vendor>.
// languageModels.ts:1698-1700
```

## 3. 阶段二：扩展激活与 provider 注册

当 VS Code 第一次需要该 vendor 的模型时，调用：

```ts
await this._extensionService.activateByEvent(`onLanguageModelChatProvider:${vendorId}`);
// languageModels.ts:1477-1479
```

扩展激活后执行：

```ts
// src/extension.ts:500-503
vscode.lm.registerLanguageModelChatProvider(DIRECT_PROFILE.vendor, provider)
```

注册链路：

```text
vscode.lm.registerLanguageModelChatProvider
  → ExtHostLanguageModels.registerLanguageModelChatProvider        extHostLanguageModels.ts:161-183
       _languageModelProviders.set(vendor, { extension, provider })
       $registerLanguageModelProvider(vendor)
       provider.onDidChangeLanguageModelChatInformation → $onLMProviderChange(vendor)
  → MainThreadLanguageModels.$registerLanguageModelProvider         mainThreadLanguageModels.ts:98-117
       LanguageModelsService.registerLanguageModelProvider(vendor, adapter)
       adapter.provideLanguageModelChatInfo → extHost.$provideLanguageModelChatInfo
       注册 auth；metadata.isBYOK 未声明时按是否为内置 Copilot 扩展补默认值
```

`LanguageModelsService.registerLanguageModelProvider`（`languageModels.ts:1695-1723`）会：

- 校验 vendor 存在、且该 vendor 尚未注册（重复注册会抛错）。
- 把 provider 存入 `_providers`。
- 订阅 provider 的 `onDidChange`，变化时调用 `_resolveAllLanguageModels(vendor, true)`。
- 返回 disposable：注销时清空该 vendor 的模型缓存与分组。

## 4. 阶段三：触发模型解析

核心是 `LanguageModelsService._resolveAllLanguageModels(vendorId, silent)`（`languageModels.ts:1463`）。

### 4.1 触发时机

| 触发源 | 调用位置 | `silent` |
|---|---|---|
| `vscode.lm.selectChatModels()` | extHost `$selectChatModels` → mainThread `selectLanguageModels` → `_resolveAllLanguageModels`（`:1670-1677`） | `true` |
| provider 发出 `onDidChange` | `registerLanguageModelProvider` 订阅（`:1707-1709`） | `true` |
| provider group 新增 / 删除 / 配置变化 | `_onDidChangeLanguageModelGroups`（`:1426-1428`） | `true` |
| Manage Models 点击管理命令 | `configureLanguageModelsProviderGroup`（`:1959-1961`） | `false` |
| 模型 picker 刷新 | 通过 `onDidChangeLanguageModels` 及 Chat 层提供的模型列表 | — |

### 4.2 两轮 provider 调用

```ts
// 第 1 轮：groupless 解析
const models = await provider.provideLanguageModelChatInfo({ silent }, ...);
// languageModels.ts:1504

// 第 2 轮：对每个属于该 vendor 的 group 再解析
const configuration = await this._resolveConfiguration(group, vendor.configuration);
const models = await provider.provideLanguageModelChatInfo(
    { group: group.name, silent, configuration }, ...
);
// languageModels.ts:1532-1560
```

`ILanguageModelChatInfoOptions`（`languageModels.ts:624`）：

```ts
export interface ILanguageModelChatInfoOptions {
    readonly group?: string;                          // provider group 名
    readonly silent: boolean;                         // 是否后台静默解析
    readonly configuration?: IStringDictionary<unknown>; // group 配置（account/instance 等）
}
```

两种特殊处理：

- **无 configuration schema 的 vendor**：如果 groupless 解析已经返回模型，则 group 只用于 per-model 配置，不再额外调用 provider（`:1539-1556`）。
- **`detail` 兜底**：group 调用返回的模型若没有 `detail`，会补成 group 名，便于区分同一 vendor 的多个实例（`:1561-1572`）。

## 5. 阶段四：返回值转换与缓存

### 5.1 扩展返回值 → metadata

`ExtHostLanguageModels.$provideLanguageModelChatInfo`（`extHostLanguageModels.ts:203-280`）逐字段构造 `ILanguageModelChatMetadata`：

- 直接复制：`id`、`name`、`family`、`version`、`detail`、`tooltip`、`multiplierNumeric`、`pricing`、上下文与配置字段等。
- 改名：`capabilities.imageInput` → `capabilities.vision`。
- 派生：`capabilities.toolCalling` → `capabilities.agentMode = !!toolCalling`。
- 补全：`extension`、`vendor`、`auth`、`isDefaultForLocation`。
- 计算 identifier：

```ts
identifier = group ? `${vendor}/${group}/${modelId}` : `${vendor}/${modelId}`
// extHostLanguageModels.ts:185-187
```

### 5.2 写入缓存

`_resolveAllLanguageModels` 在成功后（`languageModels.ts:1600-1630`）：

1. 先 `_clearModelCache(vendor)`，移除该 vendor 的旧模型。
2. 遍历两轮解析结果写入 `_modelCache`。
3. 同一 identifier 重复时跳过并告警：

```text
[LM] Model <identifier> is already registered. Skipping.
// languageModels.ts:1609-1614
```

4. 更新 `_modelsGroups`：记录每个 group 及其 `modelIdentifiers`（用于分组展示和模型→group 归属解析）。
5. 触发 `onDidChangeLanguageModels(vendor)`，并更新上下文键（是否有用户可选模型）。

因此：**provider 不再返回的模型会自动从 picker 消失**，无需显式删除。

### 5.3 可见性

- 对 `isDefault` vendor（Copilot），`isUserSelectable === false` 的模型会被跳过（`:1507-1515`）；其他 vendor 的模型全部加入缓存。
- 用户级别的隐藏/固定模型保存在 `chatModelVisibility` / `chatModelPinned` 存储中，由 picker 层应用，不影响 `_modelCache`。
- vendor 的 `when` 子句只影响 `getVendors()` 的可见性，不影响解析本身。

## 6. 阶段五：消费方

缓存就绪后，主要查询入口：

| API | 位置 | 说明 |
|---|---|---|
| `getLanguageModelIds()` | `:1446` | 全部已解析模型的 identifier |
| `lookupLanguageModel(identifier)` | `:1450` | 按 identifier 取 metadata |
| `lookupLanguageModelByQualifiedName("Name (vendor)")` | `:1454` | prompt/agent 文件中的限定名查找 |
| `selectLanguageModels(selector)` | `:1670` | 触发解析后按 vendor/family/version/id 过滤 |
| `getLanguageModelGroups(vendor)` | `:1662` | 分组结构（含错误状态） |
| `onDidChangeLanguageModels` | `:1258` | 模型集合变化事件 |

模型 picker 监听 `onDidChangeLanguageModels` 刷新列表（`modelPickerWidget.ts:225`），并通过 `ILanguageModelsService` 读取模型 id、可见性、配置与固定/隐藏状态。`vscode.lm.selectChatModels` 则经 `mainThreadLanguageModels.ts:215-216` 调用 `selectLanguageModels`，同时承担"触发发现"的职责。

## 7. 本扩展的行为

### 7.1 注册点

```ts
// src/extension.ts:54-71
const store = new ModelStore({ client, memento: context.globalState, ... });
const provider = new QoderProvider(store, client, logger, DIRECT_PROFILE, ...);
...
vscode.lm.registerLanguageModelChatProvider(DIRECT_PROFILE.vendor, provider)
```

### 7.2 解析策略

`QoderProvider.provideLanguageModelChatInformation`（`src/provider.ts:53-103`）：

| 调用类型 | 行为 |
|---|---|
| groupless（`configuration === undefined`） | Direct profile 返回 `[]`；非 silent 时提示登录。避免 group 删除后复活无 group 模型（`:59-64`） |
| 首次 group 调用 | `queueMicrotask(() => changeEmitter.fire())`，让 VS Code 再解析一次，用 group 模型替换第一轮的无 group 结果（`:65-70`） |
| 后续 groupless 调用 | 若已观察过 group，返回 `[]`，防止重复模型（`:71-75`） |
| group 调用 | `store.load(false, signal)` → `ProviderModel[]`（`:81-93`） |

模型来源：

```text
DirectQoderClient.fetchModels()  →  Qoder Hub /models
        ↓
ModelStore（globalState 缓存，TTL 1 小时，single-flight，stale 兜底）
        ↓
toProviderModels(...)  →  ProviderModel[]
```

### 7.3 何时重新发现

| 场景 | 代码 | 效果 |
|---|---|---|
| 设备流登录成功 | `extension.ts:215-220` | `store.clear()` + `store.refresh()` + `provider.refresh()` |
| 登出 | `extension.ts:246-247` | 清空缓存并刷新 provider |
| PAT 导入成功 | `extension.ts:347-355` | 同上 |
| `qoderDirect.refreshModels` 命令 | `extension.ts:436-438` | 清空缓存、重新拉取、刷新 provider |
| secret 变化 | `extension.ts:489-494` | 清空缓存并刷新 provider / 配额 |

`provider.refresh()`（`provider.ts:216-218`）触发 `onDidChangeLanguageModelChatInformation`，经 extHost `$onLMProviderChange` 让 workbench 重新执行 `_resolveAllLanguageModels(vendor, true)`。

### 7.4 Provider group

本扩展的模型**只通过 group 提供**：

```text
登录 / 导入 PAT 成功
  → lm.addLanguageModelsProviderGroup({ name, vendor, account, instance })
        extension.ts:75-97
  → LanguageModelsConfigurationService 保存 group
  → _onDidChangeLanguageModelGroups
  → 对每个 group 调用 provider({ group, configuration })
        languageModels.ts:1558
```

- `configuration` 中的 `account` / `instance` 会随 group 调用传给扩展。
- 没有 group 时，`managementCommand`（`qoderDirect.signIn`）是 Manage Models 中的添加入口。
- 删除 group 会触发重新解析；由于 provider 对 groupless 调用返回 `[]`，模型随之消失。

## 8. 完整时序

```text
┌──────────────┐
│ VS Code 启动 │
└──────┬───────┘
       │ 解析 contributes.languageModelChatProviders
       ▼
  注册 vendor qoder-direct
  生成激活事件 onLanguageModelChatProvider:qoder-direct
       │
       │ 用户打开模型 picker / 扩展调用 selectChatModels / group 变化
       ▼
  activateByEvent(onLanguageModelChatProvider:qoder-direct)
       │
       ▼
  extension activate()
  └─ new ModelStore(...) / new QoderProvider(...)
  └─ vscode.lm.registerLanguageModelChatProvider("qoder-direct", provider)
       │
       ▼
  ExtHostLanguageModels → MainThreadLanguageModels → LanguageModelsService
       │
       ▼
  _resolveAllLanguageModels("qoder-direct", silent)
  ├─ provider.provideLanguageModelChatInfo({ silent })                    → []
  └─ provider.provideLanguageModelChatInfo({ group, configuration })      → ProviderModel[]
       │
       ▼
  映射为 ILanguageModelChatMetadata + identifier
  写入 _modelCache / _modelsGroups
  触发 onDidChangeLanguageModels
       │
       ▼
  模型 picker 展示 / Chat 请求 / vscode.lm.selectChatModels
```

## 9. 常见问题

| 现象 | 原因 |
|---|---|
| picker 中没有模型 | vendor 未在 `contributes.languageModelChatProviders` 声明；或 provider 对 groupless/group 调用都返回空 |
| `Chat model provider uses UNKNOWN vendor` | provider 注册早于扩展点解析，或 vendor 拼写不一致 |
| `already registered` 错误 | 同一 vendor 在同一窗口重复调用 `registerLanguageModelChatProvider` |
| 修改模型后 picker 不更新 | 未触发 `onDidChangeLanguageModelChatInformation`（本扩展需调用 `provider.refresh()`） |
| 删除 group 后模型仍在 | provider 在 groupless 调用中仍返回模型；本扩展通过"只响应 group 调用"避免此问题 |
| 同一模型出现两次 | 同一 identifier 被两个 group 返回；服务会跳过重复项并告警 |
| 后台刷新频繁弹登录框 | 在 `silent === true` 时不要弹 UI；本扩展仅在非 silent 时提示 |

## 10. 参考资料

VS Code：

- `src/vs/workbench/contrib/chat/common/languageModels.ts` — 扩展点、`LanguageModelsService`、解析与缓存
- `src/vs/workbench/api/common/extHostLanguageModels.ts` — provider 注册与 metadata 映射
- `src/vs/workbench/api/browser/mainThreadLanguageModels.ts` — 主进程桥接、auth、`isBYOK` 兜底
- `src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts` — provider group 配置
- `src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/` — picker 对模型与成本的展示
- `src/vscode-dts/vscode.d.ts` — 稳定 `LanguageModelChatProvider` / `LanguageModelChatInformation`
- `src/vscode-dts/vscode.proposed.chatProvider.d.ts` — 提案字段与 group 相关能力

本扩展：

- `package.json` — `activationEvents` / `languageModelChatProviders`
- `src/extension.ts` — 激活、注册、登录流程、group 创建、缓存刷新
- `src/provider.ts` — `provideLanguageModelChatInformation` 与请求处理
- `src/core/modelStore.ts` — 模型缓存与拉取
- `src/core/models.ts` — `toProviderModels`