# Qoder CN Provider for Copilot

在 VS Code 原生聊天模型选择器中直连 Qoder CN。扩展使用 Qoder 设备 OAuth 登录，直接访问 Qoder 上游，并把可用模型注册为原生语言模型提供方。

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

## 命令

| 命令 | 用途 |
| --- | --- |
| **Qoder Direct: 登录 (Sign In)** | 通过 OAuth 设备授权登录公共 CN 或 VPC 实例，并创建模型提供方分组。 |
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
- 不展示推理内容；当前版本禁用图片输入。
- 项目包含第三方 MIT 代码，归属信息见 `NOTICE`。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
npm run package
code --install-extension qoder-cn-copilot-provider-0.1.0.vsix
```

按 F5 启动扩展开发宿主。Provider API 是稳定接口，不需要 proposed-API 参数。单元测试全部使用 mock，不需要真实 Qoder 账号；真实联调需要 Qoder 账号和浏览器设备授权。

## 故障排查

- **找不到命令**：命令名称已本地化。可以搜索 `Qoder Direct` 或 `登录`；英文环境下显示为 `Qoder Direct: Sign In (登录)`。
- **浏览器跳转 `qoder-work-cn://` 失败**：在页面中完成账号授权即可，扩展仍可能通过轮询获取令牌。
- **VPC 登录失败**：扩展宿主和浏览器都必须能访问该实例的 website / openapi / gateway 主机。运行 **Qoder Direct: 显示日志 (Show Logs)** 查看派生出的主机地址。
- **组织 SSO 阻止设备授权**：需要联系组织管理员允许设备授权后再登录。
- **删除分组后模型仍存在**：删除分组不会退出登录；运行 **Qoder Direct: 退出登录 (Sign Out)** 或重新加载窗口。模型只通过 `Qoder Direct` 分组提供。

## 许可证

MIT。见 `LICENSE` 和 `NOTICE`。
