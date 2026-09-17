# 配置与安全

## 配置来源

运行时读取根目录 `config.json`；不存在时从 `config.json.template` 自动复制。`config.json` 被 Git 忽略，不能提交或在文档中输出真实密钥。模板必须与 `src/config.ts` 的新增字段同步。修改后重启 Server。

常用字段：

| 字段 | 作用 | 默认/注意 |
|---|---|---|
| `ip` / `port` | HTTP/WebSocket 监听地址和端口 | 代码默认 `127.0.0.1:45678`；模板是集成示例 |
| `allowedIps` | HTTP、WebSocket 和 `/ab` 来源白名单 | 缺失或空数组回退到 `127.0.0.1`、`::1` |
| `authToken` | AI-facing HTTP 的 Bearer 认证 | 空值表示不启用；不要写入日志 |
| `allowedTools` | 工具名白名单 | 空数组表示所有安全注册工具 |
| `evalEnabled` | 任意代码执行工具门控 | 建议不需要时设为 `false` |
| `encryption` / `encryptionKey` | Bridge 载荷 AES-256-CBC | 不是 TLS；不能替代网络层加密 |
| `limits` | body、上传、prompt、context、并发和参数大小 | 具体默认值见模板与 `config.ts` |
| `llm` | AI 请求转发 | API key 可由 `LLM_API_KEY` 环境变量覆盖 |
| `mcpServers` | 外部 MCP 子进程 | `enabled:false` 可临时停用；重启生效 |
| `webSearch` | `web.search` provider 顺序和超时 | 未配置凭据的 provider 会跳过 |

## 访问边界

默认目标是本机使用。把 `ip` 设为 `0.0.0.0` 会扩大监听面，必须同时审查 `allowedIps`、`authToken`、防火墙和 `evalEnabled`。`/health` 也受访问控制。`/ab` 能读写 AssetBundle 缓存，来源白名单不可绕过。

`evalEnabled` 关闭时，列表中隐藏并在执行时拒绝：Unity `editor.eval`、名称匹配危险后缀的 adapter 工具，以及内置 Blender 模板/高级/导出工具。Blender 的任意 Python 执行等同于当前用户权限，只有可信环境才应开启。

## 外部 adapter

每个 `mcpServers` 条目包含 `name`、`command`，可选 `args`、`env`、`toolsPrefix`、`enabled`。子进程崩溃后会按 10/30/60/120 秒退避重连。adapter 在线只说明 MCP 子进程连通，不代表其后端应用（例如 Blender Add-on）健康；以 `/health.adapters`、工具调用和后端状态共同判断。
