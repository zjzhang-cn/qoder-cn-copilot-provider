# Qoder CN Provider for Copilot

在 VS Code 原生聊天模型选择器中直连 Qoder CN。扩展支持 Qoder 设备 OAuth 登录和 PAT（个人访问令牌）导入，直接访问 Qoder 上游，并把可用模型注册为原生语言模型提供方。

## 环境要求

- VS Code 1.136 或更高版本。
- 一个 Qoder CN 账号（公共 `qoder.com.cn`，或企业 VPC 实例）。

## 安装与登录

1. 安装扩展并重新加载 VS Code 窗口。
2. 打开命令面板，运行 **Qoder Direct: 登录 (Sign In)**。
3. 选择 **Qoder CN（公共）** 或 **Qoder CN（VPC）**。VPC 只需填写实例名，例如 `acme`。
4. 在浏览器中完成授权。扩展最多轮询 10 分钟。
5. 在模型选择器中选择 **Qoder（直连）** 下的模型。

访问令牌和刷新令牌只保存在 VS Code `SecretStorage`。访问令牌到期前会自动刷新；遇到 `401` 时会强制刷新一次并重试。

### PAT 登录（个人访问令牌）

组织 SSO 拦截设备授权、或不想走浏览器时，可以用 PAT 登录：

1. 在 Qoder 网页版「设置 → Personal Access Token」创建一个 `pt-` 令牌。
2. 运行 **Qoder Direct: 导入 PAT (Import PAT)**，选择公共 CN 或 VPC 实例，粘贴令牌。
3. 扩展用 PAT 交换 `jt-` 访问令牌和 `jrt-` 刷新令牌（有效期以服务端返回为准，通常分别约 24 / 48 小时），并拉取账号身份；身份获取失败时导入整体失败，不会保存半成品凭证。
4. 已有登录时会先弹确认框（显示当前账号名）；确认后 PAT 会话替换当前会话。

PAT 与令牌一起保存在 `SecretStorage`，作为最后兜底：`jrt-` 刷新失败（含网络错误）时自动用 PAT 重新交换；当服务端以会话失效错误（如 `TOKEN_EXPIRE`）拒绝 PAT 时，提示重新导入。PAT 不会出现在日志中。

## 命令

| 命令 | 用途 |
| --- | --- |
| **Qoder Direct: 登录 (Sign In)** | 通过 OAuth 设备授权登录公共 CN 或 VPC 实例，并创建模型提供方分组。 |
| **Qoder Direct: 导入 PAT (Import PAT)** | 用 `pt-` 个人访问令牌登录公共 CN 或 VPC 实例，并创建模型提供方分组。 |
| **Qoder Direct: 退出登录 (Sign Out)** | 清除已保存的 Qoder 令牌和模型缓存。 |
| **Qoder Direct: 刷新模型 (Refresh Models)** | 刷新模型列表和缓存。 |
| **Qoder Direct: 创建模型提供方分组 (Create Provider Group)** | 使用当前登录重新创建分组。 |
| **Qoder Direct: 删除模型提供方分组 (Delete Provider Group)** | 尝试调用 VS Code 内部删除命令；不可用时提示到“管理语言模型”中删除。 |
| **Qoder Direct: 显示日志 (Show Logs)** | 打开扩展输出通道。 |

## 行为说明

- 模型 id 使用 Qoder `upstream_key`；选择器中显示官方模型名称。
- 模型列表通过带签名的 Qoder 请求获取，缓存 1 小时；请求失败时回退到最近一次缓存。
- Context Size 以 `model_config.max_input_tokens` 发送，Effort Level 以 `reasoning_effort` 发送。
- 工具调用为原生调用；支持结构化历史和文本标记历史，并提供基础的工具调用文本恢复。
- 同一时间只允许一个聊天请求，请求间隔 300ms；限流通过锁文件跨 VS Code 窗口生效。
- 会话 ID 由工作区、系统提示和首条用户消息派生，保证多轮对话稳定。
- **用量统计**：上游返回的 token 用量（输入/输出/缓存命中）会转发给 VS Code 聊天界面显示，不再恒为 0。
- 不展示推理内容。
- **图片输入**：视觉模型（目录 `is_vl` 标记）支持在聊天中粘贴/拖拽图片，扩展把内联图片以 `image_url` 部件随消息发送；非视觉模型附图时自动降级为文字提示，不阻断对话。仅支持内联图片（不支持远程 URL）；单次请求编码后超过约 29MB 会本地拦截并提示减少图片。可用 per-model `imageInput` override 强制开/关。
- 项目包含第三方 MIT 代码，归属信息见 `NOTICE`。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
npm run package
code --install-extension qoder-cn-copilot-provider-0.2.0.vsix
```

按 F5 启动扩展开发宿主。Provider API 是稳定接口，不需要 proposed-API 参数。单元测试全部使用 mock，不需要真实 Qoder 账号；真实联调需要 Qoder 账号和浏览器设备授权。

## 故障排查

- **找不到命令**：命令名称已本地化。可以搜索 `Qoder Direct` 或 `登录`；英文环境下显示为 `Qoder Direct: Sign In (登录)`。
- **浏览器跳转 `qoder-work-cn://` 失败**：在页面中完成账号授权即可，扩展仍可能通过轮询获取令牌。
- **VPC 登录失败**：扩展宿主和浏览器都必须能访问该实例的 website / openapi / gateway 主机。运行 **Qoder Direct: 显示日志 (Show Logs)** 查看派生出的主机地址。
- **组织 SSO 阻止设备授权**：改用 **Qoder Direct: 导入 PAT (Import PAT)**，在网页版「设置 → Personal Access Token」签发令牌后导入；或联系组织管理员允许设备授权。
- **PAT 导入失败**：确认令牌以 `pt-` 开头且未过期/未被吊销；VPC 实例需能访问对应 openapi 主机。提示“Qoder PAT 已失效或被吊销，请重新导入 PAT”时重新创建并导入令牌。
- **管理界面只有设备登录**：VS Code 分组管理入口（`managementCommand`）指向设备登录；PAT 导入请用命令面板 **Qoder Direct: 导入 PAT (Import PAT)**，或无模型时恢复提示中的 **导入 PAT** 按钮。
- **删除分组后模型仍存在**：删除分组不会退出登录；运行 **Qoder Direct: 退出登录 (Sign Out)** 或重新加载窗口。模型只通过 `Qoder Direct` 分组提供。

## 许可证

MIT。见 `LICENSE` 和 `NOTICE`。
