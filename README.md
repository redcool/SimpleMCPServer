# SimpleMcpServer

**Simple 是代号：面向人类与 AI 的大门，连接工具与创作环境的中枢。**

Node.js + TypeScript 实现的 MCP 工具网关：向 AI 客户端提供统一入口，通过 WebSocket 连接 Unity/Godot Bridge，通过外部 MCP 适配器连接 BlenderMCP 等工具服务，并提供服务端搜索、LLM 转发和 AssetBundle 中转能力。

本仓库不包含 Unity/Godot Bridge 或 Blender Add-on；它们是按需接入的后端，**启动 Server 不要求先安装 Unity**。

## 架构

```text
人类 → AI 客户端
           │ MCP Streamable HTTP / 兼容 SSE
           ▼
     SimpleMcpServer
       ├─ 服务端工具：bridge.list / bridge.call / web.search
       ├─ WebSocket → Unity / Godot Bridge → 编辑器或游戏
       ├─ MCP Client（stdio）→ 外部 MCP Server → Blender Add-on 等
       └─ HTTP /rpc、/health、/ab：脚本、状态与资源中转
```

**注意传输方向**：当前 `dist/index.js` 启动 HTTP/WebSocket 服务，不提供面向 AI 客户端的 stdio MCP 服务。stdio 用于 Server 启动外部 MCP 子进程。

## 快速开始

需要 Node.js 22+ 与 npm。在仓库根目录执行：

```powershell
npm ci
npm run build
```

首次启动前准备配置（不会覆盖已有文件）：

```powershell
if (-not (Test-Path config.json)) { Copy-Item config.json.template config.json }
```

按需编辑本机 `config.json`：本地使用建议 `ip` 设为 `127.0.0.1`；不使用 LLM 时将 `llm.enabled` 设为 `false`；不使用 Blender 时将 `mcpServers` 设为 `[]` 或禁用对应条目；不需要代码执行时将 `evalEnabled` 设为 `false`。不要提交真实密钥。

> 模板是集成示例，不是最小配置：它监听 `0.0.0.0`（仍有回环 IP 白名单），启用 LLM 占位配置、Blender 适配器及 eval。缺少配置时程序会自动复制模板，因此建议先审阅再启动。详见 [配置与安全](docs/configuration.md)。

```powershell
npm start
# 在另一个终端检查；设置 authToken 时需带 Authorization: Bearer <token>
Invoke-RestMethod http://127.0.0.1:45678/health
```

Windows 也可用 `start.bat`（构建后启动），或 `start-quick.bat`（只运行已有 dist）。`setup.bat` 执行依赖安装和构建。

## AI 客户端连接

在客户端选择 **Streamable HTTP**，填写：

```text
http://127.0.0.1:45678/mcp-stream
```

不同客户端配置格式不一致；支持 `mcpServers` / `url` 格式的客户端可参考：

```json
{
  "mcpServers": {
    "simple": { "url": "http://127.0.0.1:45678/mcp-stream" }
  }
}
```

如客户端要求 `type` 或认证请求头，按其说明补充。旧 SSE 客户端使用 `/sse`；不要用 `command: node dist/index.js` 代替网络连接配置。

| 入口 | 用途 |
|---|---|
| `GET/POST /mcp-stream` | MCP Streamable HTTP，优先使用 |
| `GET /sse` + `POST /mcp?sessionId=...` | 兼容旧 SSE 客户端 |
| `POST /rpc` | 脚本用直接 JSON-RPC，不是完整 MCP 会话传输 |
| `GET /health` | Server、Bridge 与 adapter 状态 |
| WebSocket，同一端口 | Unity/Godot Bridge 注册和调用 |
| `POST /ab?name=...`、`GET /ab/<file>` | AssetBundle 中转 |

`/health.totalTools` 当前仅统计 Bridge 路由，不是全部可用工具数。工具清单以 `tools/list` 为准，adapter 在线也不代表 Blender Add-on 或场景可用。

## 文档导航

- [文档索引](docs/README.md)：当前指南、专题与历史记录。
- [架构与目录](docs/architecture.md)：模块边界、工具路由与目录约定。
- [配置与安全](docs/configuration.md)：配置来源、权限边界和限制。
- [后端接入](docs/integrations.md)：Unity/Godot、Blender 与多实例前置条件。
- [开发与验证](docs/development.md)：命令、测试范围、已知问题和排查。
- [Blender 工具](docs/blender-mcp-template-tools.md)、[搜索指南](docs/SimpleMCPServer搜索指南.md)。
- [Agent 协作规则](AGENTS.md)：改动前必读；[会话历史](session_memory.md) 不代表当前运行状态。

## 验证范围

```powershell
npm test
```

这会构建 TypeScript 并运行 `tests/*.test.cjs`。现有测试包含模块回归和 Blender 源码静态检查，**不等于 Unity/Godot/Blender 的端到端验证**。外部环境测试须单独准备，见开发指南。

## 相关仓库

- [SimpleMcpServer](https://github.com/redcool/SimpleMCPServer)
- [Unity Bridge](https://github.com/redcool/SimpleMCPBridge_Unity)

当前文档按 2026-09-15 工作树核对；历史说明保留在 [整理前 README](docs/archive/README-before-reorganization.md)，不作为现行操作依据。
