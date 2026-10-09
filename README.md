# SimpleMcpServer

**Simple 是代号：面向人类与 AI 的大门，连接工具与创作环境的中枢。**

Node.js + TypeScript 实现的 MCP 工具网关：向 AI 客户端提供统一入口，通过 WebSocket 连接 Unity/Godot Bridge，通过外部 MCP 适配器连接 BlenderMCP / Unreal MCP 等工具服务，并提供服务端搜索、LLM 转发和 AssetBundle 中转能力。

当前支持控制的引擎/工具：

- **Unity**（Bridge `SimpleMCPBridge`，WebSocket 接入）
- **Godot**（Bridge `SimpleMCPBridge_Godot`，WebSocket 接入）
- **Blender**（`blender-mcp` 外部适配器 + 内置模板工具，stdio 接入）
- **Unreal**（Unreal MCP Toolkit 外部适配器 + 本仓库 `unreal5/` 的 `MCPUnrealBridge` C++ 插件源码，Streamable HTTP 接入）

本仓库不包含 Unity/Godot Bridge 本体（它们是独立仓库，按需接入）；Blender Add-on 也需单独安装；Unreal 侧需要 UE 编辑器能启动 MCP Toolkit（`unreal5/` 提供插件源码与同步脚本）。**启动 Server 不要求先安装任何引擎。**

## 架构

```text
人类 → AI 客户端
           │ MCP Streamable HTTP / 兼容 SSE
           ▼
     SimpleMcpServer
       ├─ 服务端工具：bridge.list / bridge.call / web.search
       ├─ WebSocket        → Unity / Godot Bridge → 编辑器或游戏
       ├─ MCP Client(stdio) → blender-mcp → Blender Add-on
       ├─ MCP Client(HTTP)  → Unreal MCP Toolkit → Unreal Editor（含 unreal5/ 插件）
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

按需编辑本机 `config.json`：本地使用建议 `ip` 设为 `127.0.0.1`；不使用 LLM 时将 `llm.enabled` 设为 `false`；不使用 Blender 时将 `mcpServers` 中对应条目 `enabled` 设为 `false`；不需要代码执行时将 `evalEnabled` 设为 `false`。不要提交真实密钥。

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

`/health.totalTools` 当前仅统计 Bridge 路由，不是全部可用工具数。工具清单以 `tools/list` 为准，adapter 在线也不代表 Blender Add-on、Unreal MCP 或场景可用。

## 工具能力总览

工具清单以 `tools/list` 为准；以下为当前主要分组：

- **服务端工具**：`bridge.list` / `bridge.call` / `web.search`（多 provider：serper/google/bing/ddg）
- **Unity/Godot Bridge 工具**：来自所连接 Bridge 的动态注册（`asset.*`、`scene.*`、`input.*`、`game.*`、`ui.*`、`editor.*` 等，以 Bridge 版本为准）
- **Blender 内置模板工具**（`evalEnabled` 门控）：`blender.rig.*` / `blender.anim.*` / `blender.mesh.*` / `blender.scene.*` / `blender.body.*` 等，见 [Blender 模板工具](docs/blender-mcp-template-tools.md)
- **Unreal 工具**（34 个，`unreal.*`，通过外部 Unreal MCP 适配器）：
  - 状态与项目：`unreal.health` / `unreal.capabilities` / `unreal.project.info` / `unreal.level.snapshot`
  - 资产与 job：`unreal.asset.manifest` / `unreal.asset.import_status` / `unreal.asset.validate` / `unreal.job.status` / `unreal.job.wait`
  - Level/Actor/材质/动画：`unreal.level.open` / `unreal.level.save` / `unreal.actor.spawn` / `unreal.actor.transform` / `unreal.material.inspect` / `unreal.animation.list` / `unreal.animation.play`
  - Model：`unreal.model.create_primitive` / `unreal.model.transform_actor` / `unreal.model.delete_actor` / `unreal.model.batch_create_primitives` / `unreal.model.assign_material` / `unreal.model.inspect*`
  - Pipeline：`unreal.pipeline.validate` / `compare_manifest` / `smoke_test` / `snapshot`
  - Fracture：`unreal.fracture.export_meshes` / `export_vat` / `export_alembic` / `export_skeletal` / `manifest` / `validate`
  - Unreal 写操作统一要求 `confirm=true` 或 `dryRun=true`，且受 `evalEnabled` / `allowedTools` 门控

### Unreal 接入说明

- **Unreal MCP 适配器**：通过 `mcpServers` 中的 `unreal` 条目（`transport: "streamable-http"`）连接 UE 编辑器侧 MCP Toolkit；`toolsPrefix` 为 `unreal`。
- **unreal5/**：本仓库唯一 Unreal 源码目录，包含 `MCPUnrealBridge` C++ 插件（原生操作与检查）、`Python/model_operations.py`、`Scripts/`（构建与同步脚本）。UE 工程只引用或同步此目录，不要把 `Binaries/Intermediate/Saved` 等同步进工程。详见 [Unreal 5 Adapter Source](unreal5/README.md)。
- 无头/非交互启动 UE MCP 需要正确配置 `ModelContextProtocolSettings`（端口/路径/自启动）；真实破碎与跨引擎导出见 [Unreal 破碎流水线](docs/unreal-fracture-pipeline.md)。

### projects.json（可选，Agent 驱动的工程/Bridge 注册表）

`projects.json` 是可选辅助文件：声明本机引擎与工程、以及控制前是否需要安装对应 Bridge。**Server 不读取、不解析、不安装**，完全由 Agent 按用户指令和 [projects-bridge-guide](docs/projects-bridge-guide.md) 执行。文件含本机路径，已被 gitignore；仓库内提供 `projects.json.template` 模板。

## 文档导航

- [文档索引](docs/README.md)：当前指南、专题与历史记录。
- [架构与目录](docs/architecture.md)：模块边界、工具路由与目录约定。
- [配置与安全](docs/configuration.md)：配置来源、权限边界和限制。
- [后端接入](docs/integrations.md)：Unity/Godot、Blender、Unreal 与多实例前置条件。
- [开发与验证](docs/development.md)：命令、测试范围、已知问题和排查。
- [Blender 工具](docs/blender-mcp-template-tools.md)、[项目与 Bridge 安装](docs/projects-bridge-guide.md)、[Unreal 破碎流水线](docs/unreal-fracture-pipeline.md)、[搜索指南](docs/SimpleMCPServer搜索指南.md)。
- [Agent 协作规则](AGENTS.md)：改动前必读；[会话历史](session_memory.md) 不代表当前运行状态。

## 验证范围

```powershell
npm test
```

这会构建 TypeScript 并运行 `tests/*.test.cjs`。现有测试包含模块回归、Blender 源码静态检查与 Unreal 适配器路由/门控回归，**不等于 Unity/Godot/Blender/Unreal 的端到端验证**。外部环境测试须单独准备，见开发指南。

## 相关仓库

- [SimpleMcpServer](https://github.com/redcool/SimpleMCPServer)
- [Unity Bridge](https://github.com/redcool/SimpleMCPBridge_Unity)（WebSocket）

当前文档按 2026-09-20 工作树核对；历史说明保留在 [整理前 README](docs/archive/README-before-reorganization.md)，不作为现行操作依据。